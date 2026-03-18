import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentState } from './state';
import { tools, SchedulingContext } from './tools';
import { getConversationHistory, saveConversation } from './memory';
import { formatUserContext } from './goals';

/**
 * Toppa Agent — LLM tool-calling loop (DeepSeek via OpenAI-compatible SDK)
 *
 * DeepSeek reliability hardening:
 * - Beta endpoint with strict mode (schema-enforced tool args)
 * - Dynamic tool_choice: "required" for operational queries, "auto" after tool results
 * - Temperature 0 for deterministic tool calling
 * - Post-response fidelity check catches operator name mismatches
 * - Tool call logging for debugging
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
  baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
});

// Strip JSON Schema bloat that LLMs don't need (saves ~10-15% of tool tokens)
function stripSchemaBloat(schema: any): any {
  if (typeof schema !== 'object' || !schema) return schema;
  delete schema.$schema;
  delete schema.additionalProperties;
  for (const key of Object.keys(schema)) {
    if (typeof schema[key] === 'object') schema[key] = stripSchemaBloat(schema[key]);
  }
  return schema;
}

// Convert tool Zod schemas to LLM function definitions (done once at module load)
const allLlmTools: OpenAI.ChatCompletionTool[] = tools.map(tool => {
  const params = stripSchemaBloat(zodToJsonSchema(tool.schema) as Record<string, unknown>);
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: params,
    },
  };
});

// Fast lookup: tool name → LLM definition, tool name → tool function
const llmToolMap = new Map(allLlmTools.map(t => [t.function.name, t]));
const toolMap = new Map(tools.map(t => [t.name, t]));

// Max tool-calling iterations to prevent infinite loops
const MAX_ITERATIONS = 10;

/**
 * Dynamic tool selection — only send relevant tools per request.
 *
 * Instead of sending all 20 tools on every message (64% of payload),
 * we group tools by category and select based on the user message.
 * Core tools (detect_operator, save_instruction, convert_currency) are always included.
 * This reduces active tools from 20 to ~6-10 per request.
 */
const TOOL_GROUPS: Record<string, { tools: string[]; keywords: RegExp }> = {
  airtime: {
    tools: ['send_airtime', 'get_operators'],
    keywords: /airtime|recharge|top.?up|credit|units|\bsend\b.*\d|operators?|network/i,
  },
  data: {
    tools: ['send_data', 'get_data_plans'],
    keywords: /\bdata\b|bundle|internet|mb\b|gb\b|plans?\b/i,
  },
  bills: {
    tools: ['pay_bill', 'get_billers'],
    keywords: /bill|electric|water|tv\b|dstv|gotv|startimes|utility|meter|smartcard/i,
  },
  gifts: {
    tools: ['buy_gift_card', 'search_gift_cards', 'get_gift_cards', 'get_gift_card_code'],
    keywords: /gift.?card|voucher|steam|netflix|amazon|spotify|itunes|google.?play|playstation|xbox|uber/i,
  },
  scheduling: {
    tools: ['schedule_task', 'my_tasks', 'cancel_task'],
    keywords: /schedul|remind|later|tomorrow|tonight|weekly|monthly|recurring|\bat\s+\d/i,
  },
  discovery: {
    tools: ['check_country', 'get_promotions'],
    keywords: /country|available|services|promo|bonus|deal|offer/i,
  },
  memory: {
    tools: ['get_instructions', 'remove_instruction'],
    keywords: /remember|forget|saved|instructions|preferences|what do you know/i,
  },
};

// Always included — essential for most interactions
const CORE_TOOLS = ['detect_operator', 'save_instruction', 'convert_currency'];

// Short casual messages that don't need extra tools
const CASUAL_MSG = /^(hey|hi|hello|yo|sup|what'?s up|gm|good morning|good evening|thanks|thank you|ok|okay|cool|bye|later)\b/i;

function selectTools(userMessage: string): OpenAI.ChatCompletionTool[] {
  const selected = new Set<string>(CORE_TOOLS);

  for (const group of Object.values(TOOL_GROUPS)) {
    if (group.keywords.test(userMessage)) {
      for (const name of group.tools) selected.add(name);
    }
  }

  // Phone numbers → add airtime + data tools
  if (/(?:\+?\d[\d\s-]{7,})/.test(userMessage)) {
    for (const name of TOOL_GROUPS.airtime.tools) selected.add(name);
    for (const name of TOOL_GROUPS.data.tools) selected.add(name);
  }

  // Safety fallback: if no groups matched and this isn't a casual greeting,
  // include ALL tools. Better to send a few extra tools than miss the right one.
  if (selected.size <= CORE_TOOLS.length && !CASUAL_MSG.test(userMessage.trim())) {
    return [...allLlmTools];
  }

  return [...selected].map(name => llmToolMap.get(name)!).filter(Boolean);
}

/**
 * System prompt — defines agent behavior
 */
const SYSTEM_PROMPT = `You are Toppa — a personal AI agent for airtime, data, bills, and gift cards across 170+ countries. Powered by Celo (cUSD).

STYLE: Plain text only, no markdown. Be concise, talk like a helpful friend. Reply in the user's language. If someone says "hey", just say hi naturally.

MEMORY: Your USER PREFERENCES section is your long-term memory — use it, don't re-ask what's saved. When a user shares ANY contact, phone, email, or preference, immediately call save_instruction.

TOOLS: You MUST call tools before stating facts about operators, plans, or pricing. NEVER guess from training data — it's outdated. Call detect_operator before identifying any phone number. Call multiple tools in ONE turn when possible.
Report EXACTLY what tools return. COPY-PASTE operator names, plans, prices from tool output. If a tool fails, say "I couldn't look that up, please try again."

CURRENCY: All amounts in cUSD. Show cUSD first, local equivalent in parentheses: "0.30 cUSD (~500 NGN)". Use "cUSD" not "$".
Local amount conversion: use EXACT division with 4 decimals. 200 NGN / 1206 = 0.1658 cUSD (NOT 0.17). Tool results have plans with cUSD and localAmount — use those directly.

PAID SERVICES: Call the tool directly — the system handles payment flow. For order_confirmation JSON:
  Airtime/Data: {"type":"order_confirmation","action":"airtime","description":"...","productAmount":5.00,"toolName":"send_airtime","toolArgs":{"phone":"+...","countryCode":"XX","amount":5.00}}
  Gift card: {"type":"order_confirmation","action":"gift_card","description":"...","productAmount":10.00,"toolName":"buy_gift_card","toolArgs":{"productId":123,"unitPrice":10.00,"recipientEmail":"...","quantity":1}}
  Bill: {"type":"order_confirmation","action":"bill","description":"...","productAmount":20.00,"toolName":"pay_bill","toolArgs":{"billerId":456,"accountNumber":"...","amount":20.00}}
Gift card toolArgs use "unitPrice" NOT "amount". All amounts in cUSD. One order at a time.

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

  // Select only relevant tools for this message (typically 5-10 instead of all 20)
  let activeTools = selectTools(userMessage);

  // Log context size before first LLM call — helps diagnose slow responses
  const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const toolNames = activeTools.map(t => t.function.name).join(', ');
  console.log(`[Agent] Context: ${messages.length} msgs, ~${totalChars} chars, ${activeTools.length}/${allLlmTools.length} tools [${toolNames}]`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const iterStart = Date.now();
    const toolChoice: 'auto' = 'auto';

    // Stream the LLM response — accumulate text + tool calls from chunks
    const stream = await llm.chat.completions.create({
      model: process.env.LLM_MODEL || 'deepseek-chat',
      temperature: 0,
      max_tokens: 1024,
      messages,
      tools: activeTools,
      tool_choice: toolChoice,
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
    const llmMs = Date.now() - iterStart;
    const toolNames = toolCallsArray.map(tc => tc.name).join(', ') || 'none';
    const textLen = textContent.length;
    console.log(`[Agent] iter=${i} llm=${llmMs}ms tools=[${toolNames}] text=${textLen}chars choice=${toolChoice}`);

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
    if (useShortCircuit) {
      const orderJson = checkPaymentShortCircuit(toolResults);
      if (orderJson) {
        finalResponse = orderJson;
        break;
      }
    }

    // Expand active tools if tool calls referenced tools not yet included.
    // E.g., detect_operator in iter 1 → LLM wants send_airtime in iter 2.
    for (const tc of toolCallsArray) {
      // If the LLM called a tool that returned payment_required, ensure paid tools are available
      for (const tr of toolResults) {
        try {
          const parsed = JSON.parse(tr.content);
          if (parsed.status === 'payment_required' && parsed.service) {
            const svcTool = llmToolMap.get(parsed.service);
            if (svcTool && !activeTools.includes(svcTool)) activeTools.push(svcTool);
          }
        } catch { /* not JSON */ }
      }
      // If the LLM called detect_operator, add airtime + data tools for the next turn
      if (tc.name === 'detect_operator') {
        for (const name of ['send_airtime', 'get_operators', 'send_data', 'get_data_plans']) {
          const t = llmToolMap.get(name);
          if (t && !activeTools.includes(t)) activeTools.push(t);
        }
      }
    }

    // Add tool results to messages for next iteration
    messages.push(...toolResults);

  }

  if (!finalResponse) {
    finalResponse = 'I ran into a processing limit. Please try a simpler request.';
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
