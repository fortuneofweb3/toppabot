import { getX402Info } from '../blockchain/x402';

/**
 * Generate the A2A Agent Card served at /.well-known/agent-card.json
 *
 * Follows the A2A protocol spec v1.0: https://a2a-protocol.org
 * Uses camelCase field names per spec (protobuf -> JSON serialization).
 */
export function generateAgentCard() {
  const apiUrl = process.env.API_URL || 'https://api.toppa.cc';
  const x402Info = getX402Info();

  return {
    name: 'Toppa',
    description: 'AI agent for digital goods and utility payments (airtime, data, bills, gift cards) across 170+ countries, powered by Celo blockchain.',
    url: `${apiUrl}/a2a`,
    provider: {
      organization: 'Toppa',
      url: apiUrl,
    },
    version: '2.0.0',

    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },

    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],

    skills: [
      {
        id: 'natural_language_processing_natural_language_generation_text_generation',
        name: 'Text Generation',
        description: 'Text Generation capabilities in Natural Language Processing for airtime, data, bills, and gift card services',
        tags: ['natural-language-processing', 'natural-language-generation', 'text-generation'],
      },
      {
        id: 'natural_language_processing_natural_language_understanding_contextual_comprehension',
        name: 'Contextual Comprehension',
        description: 'Contextual Comprehension capabilities for understanding payment requests, phone numbers, and country-specific services',
        tags: ['natural-language-processing', 'natural-language-understanding', 'contextual-comprehension'],
      },
      {
        id: 'natural_language_processing_conversation_chatbot',
        name: 'Chatbot',
        description: 'Conversational AI for guiding users through airtime top-ups, data bundles, bill payments, and gift card purchases',
        tags: ['natural-language-processing', 'conversation', 'chatbot'],
      },
      {
        id: 'natural_language_processing_information_retrieval_synthesis_search',
        name: 'Search',
        description: 'Search capabilities for finding mobile operators, data plans, utility billers, and gift card brands across 170+ countries',
        tags: ['natural-language-processing', 'information-retrieval-synthesis', 'search'],
      },
      {
        id: 'tool_interaction_automation_workflow_automation',
        name: 'Workflow Automation',
        description: 'Automated workflows for end-to-end payment processing via x402 micropayments on Celo blockchain',
        tags: ['tool-interaction', 'automation', 'workflow-automation'],
      },
      {
        id: 'problem_solving',
        name: 'Problem Solving',
        description: 'Problem solving capabilities for resolving payment issues, operator selection, and service availability',
        tags: ['natural-language-processing', 'analytical-and-logical-reasoning', 'problem-solving'],
      },
      {
        id: 'question_answering',
        name: 'Question Answering',
        description: 'Question answering for service availability, pricing, operator details, and transaction status across 170+ countries',
        tags: ['natural-language-processing', 'information-retrieval-and-synthesis', 'question-answering'],
      },
      {
        id: 'cryptocurrency',
        name: 'Cryptocurrency',
        description: 'Cryptocurrency payment processing via cUSD stablecoins on Celo blockchain using x402 protocol',
        tags: ['technology', 'blockchain', 'cryptocurrency'],
      },
      {
        id: 'smart_contracts',
        name: 'Smart Contracts',
        description: 'Smart contract interaction for on-chain identity (ERC-8004), reputation tracking, and payment verification',
        tags: ['technology', 'blockchain', 'smart-contracts'],
      },
      {
        id: 'digital_payments',
        name: 'Digital Payments',
        description: 'Digital payment processing for airtime, data bundles, utility bills, and gift cards across 170+ countries',
        tags: ['finance-and-business', 'finance', 'digital-payments'],
      },
    ],

    // Additional protocol info (not part of A2A spec, but useful for clients)
    extensions: {
      x402: {
        spec: x402Info.spec,
        fee: x402Info.fee,
        currency: x402Info.currency,
        chain: x402Info.chain,
        payTo: x402Info.payTo,
        description: `Paid operations require x402 payment in ${x402Info.currency} on ${x402Info.chain}. Free discovery operations require no auth.`,
      },
      mcp: {
        endpoint: `${apiUrl}/mcp`,
        transport: 'Streamable HTTP',
        description: 'MCP endpoint for direct tool invocation (14 tools)',
      },
    },
  };
}
