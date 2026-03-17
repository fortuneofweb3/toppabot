import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentState } from './state';
import { tools, setSchedulingContext } from './tools';
import { getConversationHistory, saveConversation } from './memory';
import { formatUserContext } from './goals';

/**
 * Toppa Agent — LLM tool-calling loop (DeepSeek via OpenAI-compatible SDK)
 *
 * The LLM has access to ALL tools (free + paid). Paid tools are safe to call —
 * they return payment_required responses instead of executing Reloadly directly.
 *
 * Actual paid execution only happens through payment-gated paths:
 * - x402 REST API: payment verified at HTTP middleware layer (server.ts)
 * - MCP tools: payment verified via paymentTxHash param (mcp/tools.ts)
 * - Telegram bot: wallet transfer + on-chain verification (bot/handlers.ts)
 */

const llm = new OpenAI({
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
});

// Convert tool Zod schemas to LLM function definitions (done once at module load)
const llmTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
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

// Max characters per tool result to keep context small and LLM fast
const MAX_TOOL_RESULT_LENGTH = 3000;

/**
 * System prompt — defines agent behavior
 */
const SYSTEM_PROMPT = `You are Toppa — a personal AI agent for airtime, data, bills, and gift cards across 170+ countries. Powered by Celo (cUSD).

FORMATTING RULE (STRICT):
Do NOT use any markdown. No asterisks, no bold, no italics, no bullet points, no headers, no code blocks in your replies. Write plain text only, like a text message. This is non-negotiable. If you catch yourself writing * or ** or # or - at the start of a line, stop and rewrite it as plain text.

HOW YOU TALK:
Be concise. Short question = short answer. Complex request = more detail.
Talk like a helpful friend, not a customer service bot. No walls of text.
If someone says "hey" or "yo", just say hi back naturally. Don't introduce yourself or list what you can do unless they ask.
When you don't know something (their country, operator, preferences), just ask naturally.
Always reply in the same language the user writes in. French = French. Yoruba = Yoruba. Swahili = Swahili.

HOW YOU THINK:
You're smart. "send my bro some credit" = check saved contacts for their brother, infer country and amount from past behavior.
You remember everything — conversation history and saved instructions persist. Don't re-ask what you already know.
When you spot something useful (a promo, a pattern, a due date), mention it in one line.
When users share contacts, numbers, or preferences, save them automatically with save_instruction. Don't ask permission, just do it.
Suggest scheduling for recurring needs when it makes sense, but don't push it every time.

WHAT YOU CAN DO:
Airtime and data top-ups (800+ operators, 170+ countries), utility bills (electricity, water, TV, internet), gift cards (300+ brands), schedule future payments, remember contacts/preferences/recurring needs.

CURRENCY AND PRICING:
ALL tool amounts are in USD (cUSD). Fields ending in "USD" are what the user pays in cUSD.
fxRate = how many local currency units per 1 USD (e.g. fxRate 1650 means 1 USD = 1650 NGN).

When showing prices to users, ALWAYS show cUSD first, then local equivalent if you know their country:
  Good: "0.93 cUSD (about 1,500 NGN)"
  Good: "5.00 cUSD (about 8,250 NGN)"
  Bad: "1,500 NGN" (missing cUSD price)
  Bad: "$0.93" (use "cUSD" not "$")

When listing plans/packages, show them with cUSD prices. Use the fxRate from tool results to convert.
When a user gives a local amount, convert it: "5000 NGN at fxRate 1650 = 3.03 cUSD"
NEVER put local currency amounts in productAmount or toolArgs.amount — always USD.

EXECUTING PAID SERVICES:
When source is 'telegram' or 'a2a', return order_confirmation JSON for paid actions:
{"type":"order_confirmation","action":"airtime|data|bill|gift_card","description":"Short human-readable description","productAmount":5.00,"toolName":"send_airtime","toolArgs":{"phone":"+...","countryCode":"XX","amount":5.00}}
productAmount and toolArgs.amount are ALWAYS in USD (cUSD). NEVER use local currency amounts.
The bot handles payment confirmation and wallet deduction.
For scheduled tasks, use schedule_task tool directly.
For discovery (checking operators, promos, etc.), call tools normally.
Handle ONE order_confirmation at a time.

EFFICIENCY:
Call multiple tools in ONE turn when possible. For example, if you need to detect an operator AND check promotions, call both tools at once instead of one at a time. Fewer turns = faster response for the user.

RULES:
All payments in cUSD on Celo blockchain.
Always confirm amount and recipient before executing.
Show transaction details after completion.
For gift cards, always retrieve and show redeem codes.
Current datetime is in system context — use it for scheduling.
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
 * Execute tool calls in parallel and return results.
 * Shared between streaming and non-streaming paths.
 */
async function executeToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
): Promise<Array<{ role: 'tool'; tool_call_id: string; content: string }>> {
  return Promise.all(
    toolCalls.map(async (toolCall) => {
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

      // Truncate large tool results to keep context small and LLM fast
      if (result.length > MAX_TOOL_RESULT_LENGTH) {
        result = result.slice(0, MAX_TOOL_RESULT_LENGTH) + '...(truncated)';
      }

      return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
    }),
  );
}

/**
 * Check tool results for payment_required short-circuit.
 * Returns order_confirmation JSON string if found, null otherwise.
 */
function checkPaymentShortCircuit(
  toolResults: Array<{ content: string }>,
): string | null {
  for (const tr of toolResults) {
    try {
      const parsed = JSON.parse(tr.content);
      if (parsed.status === 'payment_required' && parsed.service && parsed.details) {
        const action = parsed.service
          .replace('send_', '')
          .replace('pay_', '')
          .replace('buy_', '');

        const d = parsed.details;
        let description = '';
        if (parsed.service === 'send_airtime') {
          description = `Send ${parsed.productAmount} cUSD airtime to ${d.phone} in ${d.countryCode}`;
        } else if (parsed.service === 'send_data') {
          description = `Send ${parsed.productAmount} cUSD data to ${d.phone} in ${d.countryCode}`;
        } else if (parsed.service === 'pay_bill') {
          description = `Pay ${parsed.productAmount} cUSD bill for account ${d.accountNumber}`;
        } else if (parsed.service === 'buy_gift_card') {
          description = `Buy ${parsed.productAmount} cUSD gift card`;
        } else {
          description = parsed.message?.split('.')[0] || `${action} service`;
        }

        return JSON.stringify({
          type: 'order_confirmation',
          action,
          description,
          productAmount: parsed.productAmount,
          toolName: parsed.service,
          toolArgs: parsed.details,
        });
      }
    } catch {
      // Not JSON or not payment_required — continue
    }
  }
  return null;
}

/**
 * Run the Toppa agent with LLM streaming support.
 *
 * Each call gets its own messages array — fully isolated between concurrent users.
 * Loads conversation history from MongoDB for context continuity.
 *
 * When onStream is provided, text chunks are emitted as the LLM generates them,
 * enabling real-time progressive display (e.g. Telegram's sendMessageDraft).
 */
export async function runToppaAgent(
  userMessage: string,
  state: Partial<AgentState> = {},
  options?: { onStream?: (chunk: string) => void },
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

  const useShortCircuit = state.source === 'telegram' || state.source === 'a2a';
  let finalResponse = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Stream the LLM response — accumulate text + tool calls from chunks
    const stream = await llm.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4-turbo-preview',
      temperature: 0.7,
      max_tokens: 1024,
      messages,
      tools: llmTools,
      stream: true,
    });

    let textContent = '';
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content — emit to stream callback
      if (delta.content) {
        textContent += delta.content;
        options?.onStream?.(delta.content);
      }

      // Tool calls — accumulate silently (args arrive in fragments)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = pendingToolCalls.get(tc.index) || { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          pendingToolCalls.set(tc.index, existing);
        }
      }
    }

    // Build assistant message for history
    const toolCallsArray = [...pendingToolCalls.values()];
    const assistantMessage: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: textContent || null,
      ...(toolCallsArray.length > 0 && {
        tool_calls: toolCallsArray.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }),
    };
    messages.push(assistantMessage);

    // No tool calls → final text response
    if (toolCallsArray.length === 0) {
      finalResponse = textContent;
      break;
    }

    // Execute all tool calls in parallel
    const toolResults = await executeToolCalls(
      toolCallsArray.map(tc => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    );

    // Short-circuit: payment_required → order_confirmation (saves LLM round trip)
    if (useShortCircuit) {
      const orderJson = checkPaymentShortCircuit(toolResults);
      if (orderJson) {
        finalResponse = orderJson;
        break;
      }
    }

    // Add tool results to messages for next iteration
    messages.push(...toolResults);
  }

  if (!finalResponse) {
    finalResponse = 'I ran into a processing limit. Please try a simpler request.';
  }

  // Save conversation to memory (non-blocking — don't slow down the response)
  if (state.userAddress) {
    saveConversation(state.userAddress, userMessage, finalResponse).catch((err: any) => console.error('[Memory Save Error]', err.message));
  }

  return { response: finalResponse };
}
