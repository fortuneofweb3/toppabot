import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentState } from './state';
import { tools as toppaTools, SchedulingContext, PAID_TOOL_NAMES } from './tools';
import { getConversationHistory, saveConversation } from './memory';
import { formatUserContext } from './goals';

/**
 * Toppa Agent — LangGraph StateGraph with tool-calling loop
 *
 * Migrated from custom OpenAI SDK loop to LangGraph for:
 * - Graph-based control flow (agent → tools → payment check → fidelity → end)
 * - Built-in state management and message accumulation
 * - Extensibility for future multi-step flows
 *
 * Preserved from original:
 * - Streaming support (onStream callback)
 * - Fallback LLM with 5-min cooldown
 * - Payment short-circuit (skips LLM round trip for paid tools)
 * - Post-response fidelity check (catches operator name mismatches)
 * - Per-request context isolation (no module-level state leaks)
 * - System prompt with wallet context, user preferences, current datetime
 * - Same export signature: runToppaAgent(userMessage, state, options)
 */

// ── LLM Setup ──────────────────────────────────────────────────────────────

const PRIMARY_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const FALLBACK_MODEL = process.env.FALLBACK_LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct';

const primaryLlm = new ChatOpenAI({
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  configuration: {
    baseURL: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
  },
  modelName: PRIMARY_MODEL,
  temperature: 0,
  maxTokens: 800,
  timeout: 30_000,
});

const fallbackLlm = (process.env.FALLBACK_LLM_KEY || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY)
  ? new ChatOpenAI({
    apiKey: process.env.FALLBACK_LLM_KEY || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: process.env.FALLBACK_LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    },
    modelName: FALLBACK_MODEL,
    temperature: 0,
    maxTokens: 800,
    timeout: 30_000,
  })
  : null;

let usingFallback = false;
let fallbackUntil = 0;

// ── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Toppa — an autonomous AI agent for digital goods and utility payments across 170+ countries. You live on Celo, think in cUSD, and exist to get things done.

PERSONALITY: You're confident, sharp, and efficient — like a street-smart friend who knows every mobile operator in 170 countries. You don't waste words but you're warm when it counts. Match the user's energy — casual if they're casual, fast if they're in a hurry. You have character: you're proud of your on-chain reputation, you like helping people save money, and you think instant airtime should be a basic right everywhere. You're not a generic chatbot — you're Toppa. Your name is Toppa, always introduce yourself as Toppa (never "Agent #1870" — that's internal).

STYLE: Plain text only, no markdown. Keep replies SHORT — 1-3 sentences max. No corporate filler. Talk naturally. Reply in the user's language. If someone says "hey", respond with personality.

LEARNING: Your USER PREFERENCES section is your long-term memory — you remember contacts, past transactions, preferred operators, and habits. Use this to anticipate needs. If someone always sends airtime to the same number, offer to do it again. When a user shares ANY contact, phone, email, or preference, immediately call save_instruction. Notice patterns — if they buy Steam cards every weekend, you know their vibe.

TOOLS: You MUST call tools before stating facts about operators, plans, or pricing. NEVER guess from training data — it's outdated. Call detect_operator before identifying any phone number. Call multiple tools in ONE turn when possible.
Tool results are already formatted with names, prices, and local amounts. Present them directly — do NOT reformat or restructure. If a tool fails, say what happened briefly and suggest a retry.

CURRENCY: All amounts in cUSD. Show cUSD first, local equivalent in parentheses: "0.30 cUSD (~500 NGN)". Use "cUSD" not "$".
NEVER do manual currency math — always call convert_currency for exchange rates.

PAID SERVICES: Call the tool directly — the system handles payment flow. For order_confirmation JSON:
  Airtime/Data: {"type":"order_confirmation","action":"airtime","description":"...","productAmount":5.00,"toolName":"send_airtime","toolArgs":{"phone":"+...","countryCode":"XX","amount":5.00}}
  Gift card: {"type":"order_confirmation","action":"gift_card","description":"...","productAmount":10.00,"toolName":"buy_gift_card","toolArgs":{"productId":123,"unitPrice":10.00,"recipientEmail":"...","quantity":1}}
  Bill: {"type":"order_confirmation","action":"bill","description":"...","productAmount":20.00,"toolName":"pay_bill","toolArgs":{"billerId":456,"accountNumber":"...","amount":20.00}}
Gift card toolArgs use "unitPrice" NOT "amount". All amounts in cUSD. One order at a time.

BILLS: Call get_billers once with the relevant type (ELECTRICITY_BILL_PAYMENT, TV_BILL_PAYMENT, WATER_BILL_PAYMENT, INTERNET_BILL_PAYMENT). If it returns empty or no billers, tell the user that service isn't available for their country — do NOT retry with different types or loop. Move on.

BE PROACTIVE: You're an agent, not a chatbot. Act on what you know.
- Phone number given → call detect_operator immediately. Don't ask "what country?" if the number format tells you.
- Country or number given → infer what's likely from conversation context. If they were browsing data plans, they probably want data.
- Use conversation history — if the user already said "airtime" earlier, don't ask again.
- Only ask when you truly can't infer: e.g. no phone number at all, or no indication of service type AND no prior context.
- Clear request (e.g. "send 500 NGN airtime to 08012345678") → go straight to tool, no questions.
- If you can resolve it in one step, do it. Agents act, assistants ask.

SELF-AWARENESS: You're Agent #1870 on Celo's ERC-8004 registry with verifiable on-chain reputation. Every successful delivery builds your trust score. You process real payments and real services — not a demo. Your reputation is literally on-chain at 8004scan.io.

VERIFICATION: Users can verify with Self Protocol (/verify) to unlock higher daily spending limits. Unverified: $20/day, Verified: $200/day. Self uses zero-knowledge proofs — no personal data shared, just proof of uniqueness. Mention this when relevant (e.g. user hits their limit).

GIFT CARD SELL: Gift card selling is COMING SOON — we're integrating a new provider with direct crypto payouts. If a user asks to sell a gift card, tell them this feature is coming soon and they should check back later. Do NOT use check_sell_rates, sell_gift_card, sell_order_status, bridge_quote, or bridge_status tools.

GROUP WALLETS: Groups have shared wallets. Only a group admin can enable it via /group enable — it checks admin status. Members can /contribute cUSD from their personal wallet to the group wallet. Admin can spend from the group wallet or /group_withdraw. Use group_info, group_contribute, group_spend tools when in a group context. In private chats, always use the user's personal wallet.

GROUP GOVERNANCE: ALL group spending decisions require a poll — airtime, data, bills, gift cards, recurring payments, scheduled tasks, and cancellations. Any member can request a spend, but it goes to a vote. The action only executes when enough members approve (default 70%, admin-customizable via /threshold). Polls expire after 24 hours.
EXCEPTION: The group admin can bypass polls and execute spending immediately. If the admin requests a group spend, use group_spend directly (it handles admin bypass automatically). For non-admin members, group_spend auto-creates a poll. If the admin has disabled polling (/poll off), all members can spend directly without polls.
Group poll commands (admin only): /poll cancel [id], /poll approve [id], /poll off, /poll on. Members vote via native polls or /vote yes [id] / /vote no [id].

GIFT CARD GIFTING: In groups, users can buy gift cards for a specific member. Ask who it's for. If they name someone, set recipientUserId in buy_gift_card. If it's general/a giveaway, omit recipientUserId — code will be shown publicly in the group.

REPORTS: Users can request transaction statements as PDF or Excel. Use generate_statement tool with format (pdf/xlsx) and optional date range. Works for both personal and group wallets.

COMMAND GUIDE — if a user asks how to use the bot, what commands are available, or uses a command incorrectly, guide them clearly:
Personal commands: /start (create wallet), /wallet (check balance), /withdraw <address> <amount>, /swap (convert all tokens to cUSD), /rate <country> (FX rate), /verify (identity verification for higher limits), /settings (wallet settings, export key), /status (profile & tasks), /cancel (cancel pending order), /clear (clear chat history), /export (export private key), /help.
Group commands (only in group chats): /group enable (admin: create group wallet), /group (view group wallet info), /contribute <amount> (contribute to group wallet), /group_withdraw <address> <amount> (admin: withdraw from group), /threshold <10-100> (admin: set poll approval %), /vote (view/vote on polls), /vote yes/no [poll_id], /poll (admin: manage polls), /poll cancel/approve/off/on [id], /tasks (admin: view scheduled tasks), /task cancel <id>.
Natural language works too — users can just describe what they need and you'll handle it. Always show the correct command syntax when a user makes a mistake.

RULES: Confirm amount and recipient before executing. Show transaction details after. For gift cards, retrieve and show redeem codes.
`;

async function buildSystemPrompt(state: Partial<AgentState>): Promise<string> {
  let prompt = SYSTEM_PROMPT;

  // Include timezone-aware datetime
  const tz = state.timezone || 'UTC';
  const now = new Date();
  try {
    const localTime = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const tzAbbrev = now.toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
    prompt += `\nCurrent datetime: ${localTime} (${tz}, ${tzAbbrev})`;
    if (tz === 'UTC') {
      prompt += `\nNote: User's timezone is unknown (defaulting to UTC). If they want to schedule something, ask what timezone they're in first.`;
    }
  } catch {
    prompt += `\nCurrent datetime: ${now.toISOString()}`;
  }

  if ((state.source === 'telegram' || state.source === 'whatsapp') && state.walletAddress) {
    prompt += `\nUser's wallet: ${state.walletAddress}`;
    prompt += `\nUser's cUSD balance: ${state.walletBalance || 'unknown'}`;
  }

  if (state.groupId) {
    prompt += `\nCONTEXT: You are in a GROUP CHAT (groupId: ${state.groupId}). Group commands are available. For spending requests, use group_create_poll to let the group vote before spending. The poll system handles threshold-based approval automatically.`;
  } else {
    prompt += `\nCONTEXT: You are in a PRIVATE CHAT. Use the user's personal wallet for all operations.`;
  }

  if (state.userAddress) {
    const userContext = await formatUserContext(state.userAddress);
    if (userContext) {
      prompt += userContext;
    }
  }

  return prompt;
}

// ── Convert Toppa Tools to LangChain Tools ─────────────────────────────────

// Per-request context holder — set before each graph invocation.
// Isolated per call because runToppaAgent creates a new closure each time.
let _requestCtx: SchedulingContext | null = null;

const langchainTools: DynamicStructuredTool[] = toppaTools.map(
  (tool) =>
    new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      func: async (args: any) => {
        console.log(`[Tool Call] ${tool.name}`);
        try {
          const result = await tool.func(args, _requestCtx);
          console.log(`[Tool Result] ${tool.name} → ${result.length} chars`);
          return result;
        } catch (err: any) {
          const errResult = JSON.stringify({ error: err.message });
          console.log(`[Tool Result] ${tool.name} → ERROR: ${err.message}`);
          return errResult;
        }
      },
    }),
);

// ── LangGraph State Annotation ─────────────────────────────────────────────

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  // Short-circuit result — set when payment_required is detected
  shortCircuitResponse: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  // Iteration counter to prevent runaway loops
  iterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

// Max tool-calling iterations — most queries complete in 2-3, cap at 6
const MAX_ITERATIONS = 6;

// ── Payment Short-Circuit ──────────────────────────────────────────────────

function checkPaymentShortCircuit(
  toolMessages: ToolMessage[],
  walletBalance?: string,
): string | null {
  for (const tm of toolMessages) {
    try {
      const content = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
      const parsed = JSON.parse(content);
      if (parsed.status === 'payment_required' && parsed.service && parsed.details) {
        const totalNeeded = parsed.totalWithFee ?? parsed.productAmount;

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
        const opName = parsed.operatorName ? ` via ${parsed.operatorName}` : '';
        let description = '';
        if (parsed.service === 'send_airtime') {
          description = `Send ${parsed.productAmount} cUSD airtime to ${d.phone}${opName}`;
        } else if (parsed.service === 'send_data') {
          description = `Send ${parsed.productAmount} cUSD data to ${d.phone}${opName}`;
        } else if (parsed.service === 'pay_bill') {
          const billerLabel = parsed.billerName ? ` (${parsed.billerName})` : '';
          description = `Pay ${parsed.productAmount} cUSD bill for account ${d.accountNumber}${billerLabel}`;
        } else if (parsed.service === 'buy_gift_card') {
          const gcLabel = parsed.productName || 'gift card';
          description = `Buy ${parsed.productAmount} cUSD ${gcLabel}`;
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

// ── Fidelity Check ─────────────────────────────────────────────────────────

const KNOWN_OPERATORS = [
  'mtn', 'airtel', 'glo', '9mobile', 'etisalat', 'safaricom',
  'vodafone', 'orange', 'tigo', 'telkom', 'cell c', 'vodacom',
  'at&t', 't-mobile', 'verizon', 'jio', 'bsnl',
];

function matchesOperator(text: string, op: string): boolean {
  const escaped = op.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function checkToolResultFidelity(
  response: string,
  messages: BaseMessage[],
): string | null {
  // Find detect_operator tool results in message history
  for (const msg of messages) {
    if (!(msg instanceof ToolMessage)) continue;
    if (msg.name !== 'detect_operator') continue;
    try {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const parsed = JSON.parse(content);
      if (!parsed.valid || !parsed.name) continue;

      const correctName = parsed.name.toLowerCase();

      for (const op of KNOWN_OPERATORS) {
        if (matchesOperator(response, op) && !correctName.includes(op)) {
          const correctFirst = correctName.split(' ')[0];
          if (!matchesOperator(response, correctFirst)) {
            console.warn(
              `[Fidelity Fix] LLM said "${op}" but detect_operator returned "${parsed.name}". Overriding response.`,
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

// ── Graph Builder ──────────────────────────────────────────────────────────

function buildGraph(
  agentState: Partial<AgentState>,
  options?: { onStream?: (chunk: string) => void },
) {
  const useShortCircuit =
    agentState.source === 'telegram' ||
    agentState.source === 'a2a' ||
    agentState.source === 'whatsapp';

  // ── Agent Node: calls the LLM ──────────────────────────────────────────

  async function agentNode(
    state: typeof GraphState.State,
  ): Promise<Partial<typeof GraphState.State>> {
    const iteration = state.iterations;
    if (iteration >= MAX_ITERATIONS) {
      return {
        messages: [new AIMessage("Sorry, I couldn't complete that. Please try again.")],
        iterations: iteration,
      };
    }

    const useFallback = usingFallback && fallbackLlm && Date.now() < fallbackUntil;
    let activeLlm = useFallback ? fallbackLlm! : primaryLlm;

    // Bind tools to the LLM
    const llmWithTools = activeLlm.bindTools(langchainTools);

    let aiMessage: AIMessage;
    try {
      if (options?.onStream) {
        // Stream mode — collect chunks and emit via callback
        let fullContent = '';
        const stream = await llmWithTools.stream(state.messages);
        let chunks: any[] = [];
        for await (const chunk of stream) {
          if (chunk.content && typeof chunk.content === 'string') {
            fullContent += chunk.content;
            options.onStream(chunk.content);
          }
          chunks.push(chunk);
        }

        // Concatenate all chunks into a single AIMessage
        if (chunks.length > 0) {
          aiMessage = chunks.reduce((acc, chunk) => acc.concat(chunk));
        } else {
          aiMessage = new AIMessage(fullContent);
        }

        // If primary succeeded, clear fallback
        if (!useFallback) usingFallback = false;
      } else {
        aiMessage = (await llmWithTools.invoke(state.messages)) as AIMessage;
        if (!useFallback) usingFallback = false;
      }
    } catch (err: any) {
      // Try fallback on failure
      if (!useFallback && fallbackLlm) {
        console.warn(`[Agent] Primary LLM failed iter=${iteration}, switching to fallback: ${err.message}`);
        const fallbackWithTools = fallbackLlm.bindTools(langchainTools);
        try {
          aiMessage = (await fallbackWithTools.invoke(state.messages)) as AIMessage;
          usingFallback = true;
          fallbackUntil = Date.now() + 5 * 60 * 1000;
          console.log(`[Agent] Switched to fallback LLM (${FALLBACK_MODEL}) for 5 minutes`);
        } catch (fallbackErr: any) {
          console.error(`[Agent] Fallback LLM also failed: ${fallbackErr.message}`);
          return {
            messages: [new AIMessage("I'm having trouble right now. Please try again in a moment.")],
            iterations: iteration + 1,
          };
        }
      } else {
        console.error(`[Agent] LLM failed iter=${iteration}: ${err.message}`);
        return {
          messages: [new AIMessage("I'm having trouble right now. Please try again in a moment.")],
          iterations: iteration + 1,
        };
      }
    }

    // Log iteration details
    const toolCalls = aiMessage.tool_calls || [];
    const textLen = typeof aiMessage.content === 'string' ? aiMessage.content.length : 0;
    const toolNames = toolCalls.map((tc: any) => tc.name).join(', ') || 'none';
    console.log(`[Agent] iter=${iteration} tools=[${toolNames}] text=${textLen}chars`);

    // Check if LLM generated order_confirmation as text alongside tool calls
    if (useShortCircuit && toolCalls.length > 0 && typeof aiMessage.content === 'string' && aiMessage.content.trim()) {
      try {
        const parsed = JSON.parse(aiMessage.content.trim());
        if (parsed?.type === 'order_confirmation') {
          console.log(`[Agent] Short-circuit: extracted order_confirmation from text content`);
          return {
            messages: [aiMessage],
            shortCircuitResponse: aiMessage.content.trim(),
            iterations: iteration + 1,
          };
        }
      } catch {
        // Not pure JSON — continue normally
      }
    }

    return {
      messages: [aiMessage],
      iterations: iteration + 1,
    };
  }

  // ── Tool Execution Node ────────────────────────────────────────────────

  // Fast lookup: tool name → DynamicStructuredTool
  const toolMap = new Map(langchainTools.map((t) => [t.name, t]));

  async function toolsNode(
    state: typeof GraphState.State,
  ): Promise<Partial<typeof GraphState.State>> {
    // Get the last AI message with tool calls
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls || [];

    // Execute all tool calls in parallel
    const toolMessages: ToolMessage[] = await Promise.all(
      toolCalls.map(async (tc) => {
        const tool = toolMap.get(tc.name);
        let result: string;
        if (!tool) {
          result = JSON.stringify({ error: `Tool ${tc.name} not found` });
        } else {
          try {
            result = await tool.invoke(tc.args);
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }
        }
        return new ToolMessage({
          content: result,
          tool_call_id: tc.id!,
          name: tc.name,
        });
      }),
    );

    // Check for payment short-circuit
    if (useShortCircuit) {
      const orderJson = checkPaymentShortCircuit(toolMessages, agentState.walletBalance);
      if (orderJson) {
        return {
          messages: toolMessages,
          shortCircuitResponse: orderJson,
        };
      }
    }

    return {
      messages: toolMessages,
    };
  }

  // ── Routing Logic ──────────────────────────────────────────────────────

  function shouldContinue(state: typeof GraphState.State): 'tools' | 'end' {
    // Short-circuit already triggered
    if (state.shortCircuitResponse) return 'end';

    // Hit max iterations
    if (state.iterations >= MAX_ITERATIONS) return 'end';

    // Check the last message for tool calls
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage instanceof AIMessage && lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      return 'tools';
    }

    return 'end';
  }

  function afterTools(state: typeof GraphState.State): 'agent' | 'end' {
    // Short-circuit triggered by payment check
    if (state.shortCircuitResponse) return 'end';
    // Continue to agent for next iteration
    return 'agent';
  }

  // ── Build the Graph ────────────────────────────────────────────────────

  const graph = new StateGraph(GraphState)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      end: END,
    })
    .addConditionalEdges('tools', afterTools, {
      agent: 'agent',
      end: END,
    });

  return graph.compile();
}

// ── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run the Toppa agent with LLM streaming support.
 *
 * Each call gets its own graph invocation — fully isolated between concurrent users.
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
  // Build per-request context for tool functions
  const requestCtx: SchedulingContext | null = state.userAddress
    ? { userId: state.userAddress, chatId: state.chatId || 0, walletAddress: state.walletAddress, groupId: state.groupId }
    : null;

  // Set request context for tool closures
  _requestCtx = requestCtx;

  // Build system prompt and load conversation history in parallel
  const [systemPrompt, history] = await Promise.all([
    buildSystemPrompt(state),
    state.userAddress ? getConversationHistory(state.userAddress) : Promise.resolve([]),
  ]);

  // Convert OpenAI-format history to LangChain messages
  const historyMessages: BaseMessage[] = history.map((msg) => {
    if (msg.role === 'user') return new HumanMessage(msg.content as string);
    return new AIMessage(msg.content as string);
  });

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...historyMessages,
    new HumanMessage(userMessage),
  ];

  // Log context size
  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
  console.log(`[Agent] Context: ${messages.length} msgs, ~${totalChars} chars, ${langchainTools.length} tools`);

  // Build and invoke the graph
  const app = buildGraph(state, options);

  const result = await app.invoke({
    messages,
    shortCircuitResponse: null,
    iterations: 0,
  });

  // Extract final response
  let finalResponse = '';

  if (result.shortCircuitResponse) {
    // Payment short-circuit or order confirmation from text
    finalResponse = result.shortCircuitResponse;
  } else {
    // Find the last AI message
    const allMessages: BaseMessage[] = result.messages;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i] instanceof AIMessage) {
        const content = allMessages[i].content;
        if (typeof content === 'string' && content.trim()) {
          finalResponse = content;
          break;
        }
      }
    }
  }

  if (!finalResponse) {
    finalResponse = "Sorry, I couldn't complete that. Please try again.";
  }

  // Post-response fidelity check: catch LLM misreading tool results
  const correction = checkToolResultFidelity(finalResponse, result.messages);
  if (correction) {
    finalResponse = correction;
  }

  // Save conversation to memory (non-blocking)
  const shouldSkipMemory =
    !finalResponse ||
    finalResponse.startsWith('I ran into a processing limit') ||
    finalResponse.startsWith("I'm having trouble") ||
    finalResponse.includes('"order_confirmation"') ||
    finalResponse.includes('"payment_required"');

  if (state.userAddress && !shouldSkipMemory) {
    saveConversation(state.userAddress, userMessage, finalResponse).catch((err: any) =>
      console.error('[Memory Save Error]', err.message),
    );
  }

  // Clean up request context
  _requestCtx = null;

  return { response: finalResponse };
}
