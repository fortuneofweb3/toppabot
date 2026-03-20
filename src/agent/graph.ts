import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentState } from './state';
import { tools, SchedulingContext } from './tools';
import { getConversationHistory, saveConversation } from './memory';
import { formatUserContext } from './goals';

/**
 * Toppa Agent — LLM tool-calling loop (DeepSeek via OpenAI-compatible SDK)
 *
 * The LLM receives ALL tools and decides what to call. No keyword routing —
 * the model is smart enough to pick the right tools from context.
 *
 * Performance wins (kept):
 * - Strict mode schemas for constrained decoding (faster tool args)
 * - Pre-formatted text tool results (less tokens for the LLM)
 * - 30s timeout prevents silent hangs
 * - Payment short-circuit skips a round trip for paid tool calls
 * - Post-response fidelity check catches operator name mismatches
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

/**
 * Prepare JSON Schema for DeepSeek strict mode (constrained decoding).
 *
 * Strict mode requires:
 * - All properties in `required`, `additionalProperties: false`
 * - Only supported constructs: object, string, number, integer, boolean, array, enum, anyOf
 *
 * zodToJsonSchema produces `{ not: {} }` for optional fields which strict mode
 * doesn't support. We simplify: optional fields become `anyOf: [type, null]`.
 */
function simplifyOptional(prop: any): any {
  if (!prop || typeof prop !== 'object' || !Array.isArray(prop.anyOf)) return prop;
  // Flatten nested anyOf and collect real types (strip `not` and `$ref`)
  const realTypes: any[] = [];
  let hasNull = false;
  const flatten = (items: any[]) => {
    for (const item of items) {
      if (item.type === 'null') { hasNull = true; continue; }
      if (item.not !== undefined || item.$ref !== undefined) continue;
      if (Array.isArray(item.anyOf)) { flatten(item.anyOf); continue; }
      realTypes.push(item);
    }
  };
  flatten(prop.anyOf);
  const desc = prop.description ? { description: prop.description } : {};
  if (realTypes.length === 1 && hasNull) return { anyOf: [realTypes[0], { type: 'null' }], ...desc };
  if (realTypes.length === 1) return { ...realTypes[0], ...desc };
  return { anyOf: hasNull ? [...realTypes, { type: 'null' }] : realTypes, ...desc };
}

function prepareSchema(schema: any): any {
  if (typeof schema !== 'object' || !schema) return schema;
  delete schema.$schema;
  delete schema.definitions;
  if (schema.type === 'object') {
    // Record types (z.record) already have additionalProperties set to a schema — preserve them.
    // Only force additionalProperties:false on structured objects (those with explicit properties).
    if (schema.additionalProperties === undefined || schema.additionalProperties === true) {
      schema.additionalProperties = false;
    }
    if (schema.properties) {
      schema.required = Object.keys(schema.properties);
      for (const key of Object.keys(schema.properties)) {
        schema.properties[key] = simplifyOptional(schema.properties[key]);
      }
    }
  }
  for (const key of Object.keys(schema)) {
    if (typeof schema[key] === 'object') schema[key] = prepareSchema(schema[key]);
  }
  return schema;
}


// Convert tool Zod schemas to LLM function definitions (done once at module load)
// prepareSchema cleans up zodToJsonSchema output for cleaner schemas
const llmTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: prepareSchema(zodToJsonSchema(tool.schema) as Record<string, unknown>),
  },
}));

// Fast lookup: tool name → tool function
const toolMap = new Map(tools.map(t => [t.name, t]));

// Max tool-calling iterations — most queries complete in 2-3, cap at 6 to prevent runaway
const MAX_ITERATIONS = 6;

/**
 * System prompt — defines agent behavior
 */
const SYSTEM_PROMPT = `You are Toppa — a personal AI agent for airtime, data, bills, and gift cards across 170+ countries. Powered by Celo (cUSD).

STYLE: Plain text only, no markdown. Keep replies SHORT — 1-3 sentences max. No filler, no extra explanations. Talk like a helpful friend. Reply in the user's language. If someone says "hey", just say hi naturally.

MEMORY: Your USER PREFERENCES section is your long-term memory — use it, don't re-ask what's saved. When a user shares ANY contact, phone, email, or preference, immediately call save_instruction.

TOOLS: You MUST call tools before stating facts about operators, plans, or pricing. NEVER guess from training data — it's outdated. Call detect_operator before identifying any phone number. Call multiple tools in ONE turn when possible.
Tool results are already formatted with names, prices, and local amounts. Present them directly — do NOT reformat or restructure. If a tool fails, say "I couldn't look that up, please try again."

CURRENCY: All amounts in cUSD. Show cUSD first, local equivalent in parentheses: "0.30 cUSD (~500 NGN)". Use "cUSD" not "$".
NEVER do manual currency math — always call convert_currency for exchange rates.

PAID SERVICES: Call the tool directly — the system handles payment flow. For order_confirmation JSON:
  Airtime/Data: {"type":"order_confirmation","action":"airtime","description":"...","productAmount":5.00,"toolName":"send_airtime","toolArgs":{"phone":"+...","countryCode":"XX","amount":5.00}}
  Gift card: {"type":"order_confirmation","action":"gift_card","description":"...","productAmount":10.00,"toolName":"buy_gift_card","toolArgs":{"productId":123,"unitPrice":10.00,"recipientEmail":"...","quantity":1}}
  Bill: {"type":"order_confirmation","action":"bill","description":"...","productAmount":20.00,"toolName":"pay_bill","toolArgs":{"billerId":456,"accountNumber":"...","amount":20.00}}
Gift card toolArgs use "unitPrice" NOT "amount". All amounts in cUSD. One order at a time.

BILLS: Call get_billers once with the relevant type (ELECTRICITY_BILL_PAYMENT, TV_BILL_PAYMENT, WATER_BILL_PAYMENT, INTERNET_BILL_PAYMENT). If it returns empty or no billers, tell the user that service isn't available for their country — do NOT retry with different types or loop. Move on.

CLARIFY FIRST: If a request is vague or missing info, ASK instead of making tool calls. Don't waste time calling multiple tools trying to figure out what the user wants.
- Phone number alone → ask "What do you need for this number — airtime, data, or bill payment? And how much?"
- Country alone → ask "What do you need? Airtime, data, bills, or gift cards?"
- Clear request (e.g. "send 500 NGN airtime to 08012345678") → go straight to tool.
One clarifying question is always faster than 3 tool calls that might be wrong.

RULES: Confirm amount and recipient before executing. Show transaction details after. For gift cards, retrieve and show redeem codes.
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
  ctx?: SchedulingContext | null,
): Promise<Array<{ role: 'tool'; tool_call_id: string; content: string }>> {
  return Promise.all(
    toolCalls.map(async (toolCall) => {
      const tool = toolMap.get(toolCall.function.name);
      let result: string;

      // Log tool name only — arguments may contain PII (phone, email, account numbers)
      console.log(`[Tool Call] ${toolCall.function.name}`);

      if (!tool) {
        result = JSON.stringify({ error: `Tool ${toolCall.function.name} not found` });
      } else {
        try {
          result = await tool.func(JSON.parse(toolCall.function.arguments), ctx);
        } catch (err: any) {
          result = JSON.stringify({ error: err.message });
        }
      }

      // Log result length only — result may contain redeem codes, PII
      console.log(`[Tool Result] ${toolCall.function.name} → ${result.length} chars`);

      return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
    }),
  );
}

/**
 * Check tool results for payment_required short-circuit.
 * Returns order_confirmation JSON string if found, null otherwise.
 * If user balance is too low, returns a plain-text insufficient balance message instead.
 */
function checkPaymentShortCircuit(
  toolResults: Array<{ content: string }>,
  walletBalance?: string,
): string | null {
  for (const tr of toolResults) {
    try {
      const parsed = JSON.parse(tr.content);
      if (parsed.status === 'payment_required' && parsed.service && parsed.details) {
        const totalNeeded = parsed.totalWithFee ?? parsed.productAmount;

        // Early balance check — reject before showing order confirmation
        // Reserve 0.05 cUSD for gas — Celo feeCurrency pre-charges gasLimit * maxFeePerGas
        // from the cUSD balance BEFORE the transfer executes. 0.01 is insufficient.
        const GAS_RESERVE = 0.05;
        if (walletBalance && !isNaN(parseFloat(walletBalance))) {
          const usable = parseFloat(walletBalance) - GAS_RESERVE;
          if (usable < totalNeeded) {
            const shortage = (totalNeeded - usable).toFixed(2);
            return `You need ${totalNeeded.toFixed(2)} cUSD for this but you only have ${usable > 0 ? usable.toFixed(2) : '0.00'} cUSD available (after gas). You're short by ${shortage} cUSD. Deposit more to your wallet (/wallet).`;
          }
        }

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
 * Verify that the LLM's response doesn't contradict tool results.
 * Catches the DeepSeek bug where it receives "MTN Nigeria" but says "Airtel Nigeria".
 * Returns a corrected response if a contradiction is found, null otherwise.
 */
const KNOWN_OPERATORS = [
  'mtn', 'airtel', 'glo', '9mobile', 'etisalat', 'safaricom',
  'vodafone', 'orange', 'tigo', 'telkom', 'cell c', 'vodacom',
  'at&t', 't-mobile', 'verizon', 'jio', 'bsnl',
];

function matchesOperator(text: string, op: string): boolean {
  // Use word boundary matching to avoid false positives (e.g., "orange" in "orange data plan")
  const escaped = op.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function checkToolResultFidelity(
  response: string,
  toolResults: Array<{ content: string; toolName?: string }>,
): string | null {
  for (const tr of toolResults) {
    if (tr.toolName !== 'detect_operator') continue;
    try {
      const parsed = JSON.parse(tr.content);
      if (!parsed.valid || !parsed.name) continue;

      const correctName = parsed.name.toLowerCase();

      // Check if the response mentions a DIFFERENT known operator
      for (const op of KNOWN_OPERATORS) {
        if (matchesOperator(response, op) && !correctName.includes(op)) {
          // Model mentioned wrong operator — check the correct one ISN'T also there
          const correctFirst = correctName.split(' ')[0];
          if (!matchesOperator(response, correctFirst)) {
            console.warn(
              `[Fidelity Fix] LLM said "${op}" but detect_operator returned "${parsed.name}". Overriding response.`
            );
            let corrected = `That number is on ${parsed.name} (${parsed.country}).`;
            if (parsed.denominationType === 'RANGE') {
              corrected += ` Supports top-ups from ${parsed.minAmountCUSD} to ${parsed.maxAmountCUSD} cUSD.`;
            }
            if (parsed.fxRate && parsed.fxRate > 1) {
              corrected += ` Rate: 1 cUSD = ${parsed.fxRate} ${parsed.localCurrency}.`;
            }
            return corrected;
          }
        }
      }
    } catch {
      // Not JSON — skip
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
  // Build per-request context — passed directly to tool functions via executeToolCalls.
  // Previously this was a module-level global that could be overwritten by concurrent requests.
  // Build ctx for any source that has a userAddress — not just Telegram.
  // A2A and future sources get tool access when they provide user identity.
  const requestCtx: SchedulingContext | null = state.userAddress
    ? { userId: state.userAddress, chatId: (state as any).chatId || 0, walletAddress: state.walletAddress }
    : null;

  // Build system prompt and load conversation history in parallel (independent I/O)
  const [systemPrompt, history] = await Promise.all([
    buildSystemPrompt(state),
    state.userAddress ? getConversationHistory(state.userAddress) : Promise.resolve([]),
  ]);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const useShortCircuit = state.source === 'telegram' || state.source === 'a2a';
  let finalResponse = '';
  // Accumulate detect_operator results across ALL iterations for fidelity check.
  let allDetectResults: Array<{ content: string; toolName?: string }> = [];

  // Log context size before first LLM call — helps diagnose slow responses
  const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  console.log(`[Agent] Context: ${messages.length} msgs, ~${totalChars} chars, ${llmTools.length} tools`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const iterStart = Date.now();

    // Stream the LLM response — accumulate text + tool calls from chunks
    // 30s timeout prevents DeepSeek hangs from leaving the user with no reply
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    let stream;
    try {
      stream = await llm.chat.completions.create({
        model: process.env.LLM_MODEL || 'deepseek-chat',
        temperature: 0,
        max_tokens: 800,
        messages,
        tools: llmTools,
        tool_choice: 'auto',
        stream: true,
      }, { signal: abortController.signal });
    } catch (err: any) {
      clearTimeout(timeout);
      console.error(`[Agent] LLM call failed iter=${i}: ${err.message}`);
      finalResponse = "I'm having trouble right now. Please try again in a moment.";
      break;
    }

    let textContent = '';
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
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
    } catch (err: any) {
      clearTimeout(timeout);
      // If we got partial text before the timeout, use it
      if (textContent.length > 10) {
        console.warn(`[Agent] LLM stream interrupted iter=${i}, using partial text (${textContent.length} chars)`);
      } else {
        console.error(`[Agent] LLM stream failed iter=${i}: ${err.message}`);
        finalResponse = "I'm having trouble right now. Please try again in a moment.";
        break;
      }
    }
    clearTimeout(timeout);

    // Build assistant message for history
    const toolCallsArray = [...pendingToolCalls.values()];
    const llmMs = Date.now() - iterStart;
    const toolNames = toolCallsArray.map(tc => tc.name).join(', ') || 'none';
    const textLen = textContent.length;
    console.log(`[Agent] iter=${i} llm=${llmMs}ms tools=[${toolNames}] text=${textLen}chars`);

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

    // If LLM generated order_confirmation as text alongside tool calls, extract it
    // instead of continuing the loop. DeepSeek sometimes generates both simultaneously.
    if (useShortCircuit && textContent) {
      try {
        const parsed = JSON.parse(textContent.trim());
        if (parsed?.type === 'order_confirmation') {
          console.log(`[Agent] Short-circuit: extracted order_confirmation from text content`);
          finalResponse = textContent.trim();
          break;
        }
      } catch {
        // Not pure JSON — continue with tool execution
      }
    }

    // Execute all tool calls in parallel
    const toolResults = await executeToolCalls(
      toolCallsArray.map(tc => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.arguments },
      })),
      requestCtx,
    );

    // Accumulate detect_operator results for post-response fidelity check
    for (let idx = 0; idx < toolResults.length; idx++) {
      if (toolCallsArray[idx]?.name === 'detect_operator') {
        allDetectResults.push({
          content: toolResults[idx].content,
          toolName: 'detect_operator',
        });
      }
    }

    // Short-circuit: payment_required → order_confirmation (saves LLM round trip)
    // Also checks balance — returns insufficient-balance message if user can't afford it.
    if (useShortCircuit) {
      const orderJson = checkPaymentShortCircuit(toolResults, state.walletBalance);
      if (orderJson) {
        finalResponse = orderJson;
        break;
      }
    }

    // Add tool results to messages for next iteration
    messages.push(...toolResults);

  }

  if (!finalResponse) {
    finalResponse = "Sorry, I couldn't complete that. Please try again.";
  }

  // Post-response fidelity check: catch DeepSeek misreading tool results
  // (e.g., tool returns "MTN Nigeria" but LLM says "Airtel Nigeria")
  if (finalResponse && allDetectResults.length > 0) {
    const correction = checkToolResultFidelity(finalResponse, allDetectResults);
    if (correction) {
      finalResponse = correction;
    }
  }

  // Save conversation to memory (non-blocking — don't slow down the response)
  // Skip: errors (poison history), order confirmations (cause DeepSeek to replay old orders),
  // and empty responses. Only save conversational messages that provide useful context.
  const shouldSkipMemory = !finalResponse
    || finalResponse.startsWith('I ran into a processing limit')
    || finalResponse.startsWith("I'm having trouble")
    || finalResponse.includes('"order_confirmation"')
    || finalResponse.includes('"payment_required"');

  if (state.userAddress && !shouldSkipMemory) {
    saveConversation(state.userAddress, userMessage, finalResponse).catch((err: any) => console.error('[Memory Save Error]', err.message));
  }

  return { response: finalResponse };
}
