import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { AgentState } from "./state";
import { tools } from "./tools";

/**
 * Toppa Agent - LangGraph Workflow
 */

// Initialize LLM with tool binding
// Supports OpenAI, DeepSeek, or any OpenAI-compatible API
const llm = new ChatOpenAI({
  modelName: process.env.LLM_MODEL || "gpt-4-turbo-preview",
  temperature: 0.7,
  openAIApiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  },
}).bindTools(tools);

/**
 * System prompt - defines agent behavior
 */
const SYSTEM_PROMPT = `You are Toppa, an autonomous AI agent for digital goods and utility payments across 170+ countries, powered by Celo blockchain.

Your capabilities:
1. **Airtime & Data**: Send mobile top-ups to any phone number across 170+ countries (800+ operators). Auto-detect operator from phone number.
2. **Utility Bills**: Pay electricity, water, TV (DStv, GOtv, Startimes), and internet bills.
3. **Gift Cards**: Buy gift cards from 300+ brands — Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Airbnb, Apple, Google Play, prepaid Visa/Mastercard, and more. Available across 14,000+ products globally.

Key strength — **Multi-intent resolution**:
Users can request multiple things at once. Parse and execute them all.
Example: "Get my brother 500 naira airtime in Nigeria, pay mom's DSTV bill in Lagos, and get me a $25 Steam gift card"
→ Execute all three: airtime top-up + bill payment + gift card purchase.

Workflow for each service:
- **Airtime**: Ask for phone number + country code → auto-detect operator → send top-up
- **Bills**: Ask for country → show billers (use get_billers) → ask for account number → pay
- **Gift Cards**: Search by brand (use search_gift_cards) or browse by country (use get_gift_cards) → confirm product + amount → ask for recipient email → purchase → retrieve redeem code

Personality:
- Friendly, helpful, and concise
- Proactive: suggest options, explain denominations, confirm before purchases
- Always confirm the amount and recipient before executing a transaction
- If country isn't clear, ask
- For gift cards, always show available denominations before purchasing

Important:
- All payments are in cUSD on Celo blockchain
- Use verify_selfclaw for anti-spam verification when needed
- Always show transaction details after completion (amounts, IDs, status)
- For gift cards, always retrieve and show the redeem code after purchase
`;

/**
 * Agent decision node - decides what to do next
 */
async function callAgent(state: AgentState) {
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...state.messages,
  ];

  const response = await llm.invoke(messages);

  return {
    messages: [...state.messages, response],
  };
}

/**
 * Check if agent should continue or end
 */
function shouldContinue(state: AgentState) {
  const lastMessage = state.messages[state.messages.length - 1];

  // If AI used tools, continue to execute them
  if (lastMessage.additional_kwargs?.tool_calls) {
    return "tools";
  }

  // Otherwise, end (send response to user)
  return END;
}

/**
 * Execute tools that the agent decided to use
 */
async function executeTools(state: AgentState) {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage.additional_kwargs?.tool_calls || [];

  // Execute each tool call
  const toolMessages = await Promise.all(
    toolCalls.map(async (toolCall: any) => {
      const tool = tools.find((t) => t.name === toolCall.function.name);
      if (!tool) {
        return new AIMessage({
          content: `Tool ${toolCall.function.name} not found`,
          tool_call_id: toolCall.id,
        });
      }

      const result = await tool.func(JSON.parse(toolCall.function.arguments));
      return new AIMessage({
        content: result,
        tool_call_id: toolCall.id,
      });
    })
  );

  return {
    messages: [...state.messages, ...toolMessages],
  };
}

/**
 * Build the agent graph
 */
export function createToppaAgent() {
  const workflow = new StateGraph<AgentState>({
    channels: {
      messages: {
        value: (prev: BaseMessage[], next: BaseMessage[]) => [...prev, ...next],
        default: () => [],
      },
      userAddress: {
        value: (prev?: string, next?: string) => next ?? prev,
      },
      amount: {
        value: (prev?: number, next?: number) => next ?? prev,
      },
      country: {
        value: (prev?: string, next?: string) => next ?? prev,
      },
      selfClawVerified: {
        value: (prev?: boolean, next?: boolean) => next ?? prev,
        default: () => false,
      },
      transactionHash: {
        value: (prev?: string, next?: string) => next ?? prev,
      },
      error: {
        value: (prev?: string, next?: string) => next ?? prev,
      },
    },
  });

  // Add nodes
  workflow.addNode("agent", callAgent);
  workflow.addNode("tools", executeTools);

  // Set entry point
  workflow.setEntryPoint("agent");

  // Add edges
  workflow.addConditionalEdges("agent", shouldContinue, {
    tools: "tools",
    [END]: END,
  });

  workflow.addEdge("tools", "agent"); // After tools, go back to agent

  return workflow.compile();
}

/**
 * Main function to run the agent
 */
export async function runToppaAgent(userMessage: string, state: Partial<AgentState> = {}) {
  const agent = createToppaAgent();

  const initialState: AgentState = {
    messages: [new HumanMessage(userMessage)],
    ...state,
  };

  const result = await agent.invoke(initialState);

  // Return the last AI message
  const lastMessage = result.messages[result.messages.length - 1];
  return {
    response: lastMessage.content,
    state: result,
  };
}
