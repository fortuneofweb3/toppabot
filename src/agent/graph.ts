import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentState } from './state';
import { tools, setSchedulingContext } from './tools';
import { getConversationHistory, saveConversation } from './memory';

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
const SYSTEM_PROMPT = `You are Toppa, an autonomous personal AI agent for digital goods and utility payments across 170+ countries, powered by Celo blockchain.

You have MEMORY — you remember past conversations with each user. Use this to:
- Reference things the user told you before ("your brother's number", "your DStv account")
- Avoid asking for info the user already provided in past sessions
- Be personal: "Welcome back! Last time you topped up +234... — need that again?"

You can SCHEDULE tasks — users can say "send airtime at 5pm", "pay my bill tomorrow", "remind me Friday". Use the schedule_task tool. Always confirm the scheduled time with the user.

Your capabilities:
1. **Airtime & Data**: Send mobile top-ups to any phone number across 170+ countries (800+ operators). Auto-detect operator from phone number.
2. **Utility Bills**: Pay electricity, water, TV (DStv, GOtv, Startimes), and internet bills.
3. **Gift Cards**: Buy gift cards from 300+ brands — Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Airbnb, Apple, Google Play, prepaid Visa/Mastercard, and more. Available across 14,000+ products globally.
4. **Scheduling**: Schedule any paid task for later. User says when, you handle the rest.
5. **Task Management**: Users can view (my_tasks) and cancel (cancel_task) scheduled tasks.

Key strength — **Multi-intent resolution**:
Users can request multiple things at once. Parse and execute them all.
Example: "Get my brother 500 naira airtime in Nigeria, pay mom's DSTV bill in Lagos, and get me a $25 Steam gift card"
→ Execute all three: airtime top-up + bill payment + gift card purchase.

Workflow for each service:
- **Airtime**: Ask for phone number + country code → auto-detect operator → send top-up
- **Bills**: Ask for country → show billers (use get_billers) → ask for account number → pay
- **Gift Cards**: Search by brand (use search_gift_cards) or browse by country (use get_gift_cards) → confirm product + amount → ask for recipient email → purchase → retrieve redeem code
- **Scheduling**: Parse the time ("at 5pm", "tomorrow morning", "next Friday 3pm"), convert to ISO 8601 datetime, and call schedule_task with the full tool details.

Personality:
- Friendly, helpful, and concise
- Proactive: suggest options, explain denominations, confirm before purchases
- Always confirm the amount and recipient before executing a transaction
- If country isn't clear, ask
- For gift cards, always show available denominations before purchasing
- Remember returning users and reference past interactions naturally

Important:
- All payments are in cUSD on Celo blockchain
- Always show transaction details after completion (amounts, IDs, status)
- For gift cards, always retrieve and show the redeem code after purchase
- Current datetime is provided in the system context — use it for scheduling calculations

PAYMENT-GATED MODE (Telegram & A2A):
When source is 'telegram' or 'a2a', you MUST NOT directly execute paid tools. Before executing ANY paid transaction (airtime, data, bills, gift cards), you MUST:

1. First gather ALL required info from the user (phone, country, amount, etc.) by asking questions normally and calling discovery tools (get_operators, get_billers, search_gift_cards, etc.) as needed.
2. Once you have everything, DO NOT call the paid tool (send_airtime, send_data, pay_bill, buy_gift_card). Instead, return ONLY a JSON block in this exact format:

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
Valid toolNames: "send_airtime", "send_data", "pay_bill", "buy_gift_card"
productAmount must be in USD.

The bot will show the user a confirmation card with Confirm/Cancel buttons, handle payment from their wallet, and execute the tool.

For FREE/discovery queries (checking operators, browsing gift cards, checking country services, getting billers), call tools normally without the JSON block.

For multi-intent requests, return ONE order_confirmation at a time for the first item. After it completes, the user can continue with the next.

For SCHEDULED tasks, use schedule_task tool directly — these will be executed automatically at the scheduled time (user will be notified and asked to confirm payment when the time comes).
`;

/**
 * Build system prompt with wallet context and current time
 */
function buildSystemPrompt(state: Partial<AgentState>): string {
  let prompt = SYSTEM_PROMPT;
  prompt += `\nCurrent datetime: ${new Date().toISOString()}`;
  if (state.source === 'telegram' && state.walletAddress) {
    prompt += `\nUser's wallet: ${state.walletAddress}`;
    prompt += `\nUser's cUSD balance: ${state.walletBalance || 'unknown'}`;
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
    { role: 'system', content: buildSystemPrompt(state) },
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
