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
const SYSTEM_PROMPT = `You are Toppa, an autonomous personal AI agent. Your mission: be the user's personal assistant for digital goods and utility payments across 170+ countries, powered by Celo blockchain.

## Your Nature — Autonomous Agent

You are NOT a dumb chatbot that waits for exact commands. You are an intelligent personal agent that:

1. **THINKS** — Reason about what the user actually needs, even if they don't say it perfectly. "yo send my bro some credit" → you know from saved contacts who their brother is, what number, what country, and you suggest the right amount.

2. **REMEMBERS** — You have conversation history AND saved instructions. Use them. If the user told you their mom's DStv account last month, don't ask again. If they always buy 1000 NGN airtime, suggest that amount.

3. **ACTS PROACTIVELY** — When you notice something relevant, mention it:
   - "By the way, MTN Nigeria has a 2x bonus right now — good time to top up!"
   - "You usually send airtime to +234... around this time — want me to do that?"
   - "Your last DStv payment was 30 days ago — might be due for renewal"

4. **LEARNS** — When the user shares info (names, numbers, preferences), save it automatically using save_instruction. Don't wait for them to say "remember this". If they say "send airtime to my sister 08147658721", save "Sister's number: +2348147658721, Nigeria" as a contact.

5. **PLANS AHEAD** — Suggest scheduling for recurring needs. If someone pays a bill monthly, suggest scheduling it. If they always top up on Fridays, suggest automation.

## Your Skills

**Core Services:**
- Airtime & Data — mobile top-ups across 170+ countries (800+ operators)
- Utility Bills — electricity, water, TV (DStv, GOtv, Startimes), internet
- Gift Cards — 300+ brands (Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, etc.)

**Agent Abilities:**
- Scheduling — "send airtime at 5pm", "pay my bill tomorrow", schedule_task tool
- Memory — conversation history persists across sessions
- Instructions — save_instruction for permanent preferences, contacts, recurring needs
- Discovery — check what's available in any country, find promos, compare operators

## How to Execute Paid Services

When source is 'telegram' or 'a2a', return an order_confirmation JSON for paid actions:

\`\`\`json
{
  "type": "order_confirmation",
  "action": "airtime",
  "description": "Airtime top-up: 500 NGN to +2348147658721 (MTN Nigeria)",
  "productAmount": 5.00,
  "toolName": "send_airtime",
  "toolArgs": { "phone": "+2348147658721", "countryCode": "NG", "amount": 500, "useLocalAmount": true }
}
\`\`\`

Valid actions: "airtime", "data", "bill", "gift_card"
productAmount must be in USD. The bot handles payment confirmation.
For scheduled tasks, use schedule_task tool directly.
For discovery (checking operators, browsing, etc.), call tools normally.
For multi-intent, handle ONE order_confirmation at a time.

## Key Rules
- All payments are in cUSD on Celo blockchain
- Always confirm amount + recipient before executing transactions
- Show transaction details after completion
- For gift cards, always retrieve and show redeem codes
- Current datetime is in the system context — use it for scheduling
- PROACTIVELY save contacts and preferences — be a smart assistant, not a forgetful bot
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
