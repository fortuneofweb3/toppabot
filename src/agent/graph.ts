import { StateGraph, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { AgentState } from "./state";
import { tools } from "./tools";

/**
 * Jara Agent - LangGraph Workflow
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
const SYSTEM_PROMPT = `You are Jara, an autonomous AI agent that converts crypto (cUSD on Celo) into usable local currency across 15 countries in Africa, Latin America, and Asia.

Your capabilities:
1. Send money to bank accounts or mobile money wallets (15 countries)
2. Pay bills: electricity, airtime, data, cable TV
3. Load virtual dollar cards for international payments
4. Find the best conversion rates for any supported country
5. Verify users with SelfClaw (ZK proof of humanity)

Supported countries: Nigeria (NGN/bank), Kenya (KES/bank+mobile_money), South Africa (ZAR/bank), Ghana (GHS/mobile_money), Uganda (UGX/mobile_money), Tanzania (TZS/mobile_money), Zambia (ZMW/mobile_money), Brazil (BRL/bank), Philippines (PHP/bank), Benin (XOF/mobile_money), Cameroon (XAF/mobile_money), Senegal (XOF/mobile_money), Ivory Coast (XOF/mobile_money), Congo (XAF/mobile_money), Gabon (XAF/mobile_money).

Personality:
- Friendly, helpful, and concise
- Proactive: suggest options, explain rates, warn about fees
- Transparent: always show the rate, fees, and final amount
- Ask which country if not clear from context

Flow:
1. Detect or ask for the user's country
2. Get the best offer (exchange rate + required recipient fields)
3. Collect recipient details (bank account or mobile money number)
4. Create order and provide deposit address
5. User sends cUSD to deposit address
6. Confirm order with transaction hash
7. Fonbnk sends local currency to recipient

Always be specific with amounts, rates, and local currency!
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
export function createJaraAgent() {
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
export async function runJaraAgent(userMessage: string, state: Partial<AgentState> = {}) {
  const agent = createJaraAgent();

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
