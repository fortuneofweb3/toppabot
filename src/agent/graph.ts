import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentState } from './state';
import { tools, setSchedulingContext } from './tools';
import { getConversationHistory, saveConversation } from './memory';
import { formatUserContext } from './goals';

/**
 * Toppa Agent — Direct OpenAI SDK with tool-calling loop
 *
 * The LLM has access to ALL tools (free + paid). Paid tools are safe to call —
 * they return payment_required responses instead of executing Reloadly directly.
 *
 * Actual paid execution only happens through payment-gated paths:
 * - x402 REST API: payment verified at HTTP middleware layer (server.ts)
 * - MCP tools: payment verified via paymentTxHash param (mcp/tools.ts)
 * - Telegram bot: wallet transfer + on-chain verification (bot/handlers.ts)
 */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
});

// Convert tool Zod schemas to OpenAI function definitions (done once at module load)
const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.schema) as Record<string, unknown>,
  },
}));

// Map tool names → tool functions for fast lookup
const toolMap = new Map(tools.map(t => [t.name, t]));

// Max tool-calling iterations to prevent infinite loops
const MAX_ITERATIONS = 10;

/**
 * System prompt — defines agent behavior
 */
const SYSTEM_PROMPT = `You are Toppa — a personal AI agent for airtime, data, bills, and gift cards across 170+ countries. Powered by Celo (cUSD).

## How You Talk
- Be concise. Short question → short answer. Complex request → more detail.
- Talk like a helpful friend, not a customer service bot. No walls of text, no bullet-point feature dumps.
- If someone says "hey" or "yo", just say hi back naturally. Don't introduce yourself or list what you can do unless they ask.
- Use markdown sparingly — bold only for key info, not for decoration.
- When you don't know something (their country, operator, preferences), just ask naturally.

## How You Think
- You're smart. "send my bro some credit" → check saved contacts for their brother, infer country and amount from past behavior.
- You remember everything — conversation history and saved instructions persist. Don't re-ask what you already know.
- When you spot something useful (a promo, a pattern, a due date), mention it in one line — don't make a whole thing of it.
- When users share contacts, numbers, or preferences, save them automatically with save_instruction. Don't ask permission, just do it.
- Suggest scheduling for recurring needs when it makes sense, but don't push it every single time.

## What You Can Do
- Airtime & data top-ups (800+ operators, 170+ countries)
- Utility bills (electricity, water, TV, internet)
- Gift cards (300+ brands)
- Schedule future payments
- Remember contacts, preferences, recurring needs

## Executing Paid Services
When source is 'telegram' or 'a2a', return order_confirmation JSON for paid actions:
\`\`\`json
{
  "type": "order_confirmation",
  "action": "airtime|data|bill|gift_card",
  "description": "Short human-readable description of the transaction",
  "productAmount": 5.00,
  "toolName": "send_airtime",
  "toolArgs": { "phone": "+...", "countryCode": "XX", "amount": 500, "useLocalAmount": true }
}
\`\`\`
productAmount is always in USD. The bot handles payment confirmation and wallet deduction.
For scheduled tasks, use schedule_task tool directly.
For discovery (checking operators, promos, etc.), call tools normally.
Handle ONE order_confirmation at a time.

## Rules
- All payments in cUSD on Celo blockchain
- Always confirm amount + recipient before executing
- Show transaction details after completion
- For gift cards, always retrieve and show redeem codes
- Current datetime is in system context — use it for scheduling
`;

/**
 * Build system prompt with wallet context and current time
 */
async function buildSystemPrompt(state: Partial<AgentState>): Promise<string> {
  let prompt = SYSTEM_PROMPT;
  prompt += `\nCurrent datetime: ${new Date().toISOString()}`;
  if (state.source === 'telegram' && state.walletAddress) {
    prompt += `\nUser's wallet: ${state.walletAddress}`;
    prompt += `\nUser's cUSD balance: ${state.walletBalance || 'unknown'}`;
  }

  // Load user's standing instructions/goals for autonomous context
  if (state.userAddress) {
    const userContext = await formatUserContext(state.userAddress);
    if (userContext) {
      prompt += userContext;
    }
  }

  return prompt;
}

/**
 * Run the Toppa agent — simple tool-calling loop using OpenAI SDK directly.
 *
 * Each call gets its own messages array — fully isolated between concurrent users.
 * Loads conversation history from MongoDB for context continuity.
 */
export async function runToppaAgent(
  userMessage: string,
  state: Partial<AgentState> = {},
): Promise<{ response: string }> {
  // Set scheduling context so schedule_task/my_tasks/cancel_task tools can access userId/chatId
  if (state.userAddress && state.source === 'telegram') {
    setSchedulingContext({ userId: state.userAddress, chatId: (state as any).chatId || 0 });
  } else {
    setSchedulingContext(null);
  }

  // Build messages with system prompt
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: await buildSystemPrompt(state) },
  ];

  // Load conversation history (provides memory across sessions)
  if (state.userAddress) {
    const history = await getConversationHistory(state.userAddress);
    messages.push(...history);
  }

  // Add the current user message
  messages.push({ role: 'user', content: userMessage });

  let finalResponse = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const completion = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4-turbo-preview',
      temperature: 0.7,
      messages,
      tools: openaiTools,
    });

    const choice = completion.choices[0];
    if (!choice) {
      finalResponse = 'No response from AI model.';
      break;
    }

    // Add assistant message to history
    messages.push(choice.message);

    // If no tool calls, we have the final text response
    if (!choice.message.tool_calls?.length) {
      finalResponse = choice.message.content || '';
      break;
    }

    // Execute all tool calls in parallel
    // Safe: paid tools return payment_required responses (never call Reloadly directly)
    const toolResults = await Promise.all(
      choice.message.tool_calls.map(async (toolCall) => {
        const tool = toolMap.get(toolCall.function.name);
        let result: string;

        if (!tool) {
          result = JSON.stringify({ error: `Tool ${toolCall.function.name} not found` });
        } else {
          try {
            result = await tool.func(JSON.parse(toolCall.function.arguments));
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }
        }

        return {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result,
        };
      }),
    );

    // Add all tool results to messages
    messages.push(...toolResults);
  }

  if (!finalResponse) {
    finalResponse = 'I ran into a processing limit. Please try a simpler request.';
  }

  // Save conversation to memory (non-blocking — don't slow down the response)
  if (state.userAddress) {
    saveConversation(state.userAddress, userMessage, finalResponse).catch(() => {});
  }

  return { response: finalResponse };
}
