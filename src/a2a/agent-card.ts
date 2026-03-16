import { getX402Info } from '../blockchain/x402';

/**
 * Generate the A2A Agent Card served at /.well-known/agent.json
 *
 * Follows the A2A protocol spec v1.0: https://a2a-protocol.org
 * Uses camelCase field names per spec (protobuf -> JSON serialization).
 */
export function generateAgentCard() {
  const apiUrl = process.env.API_URL || 'https://toppa.cc';
  const x402Info = getX402Info();

  return {
    name: 'Toppa',
    description: 'AI agent for digital goods and utility payments (airtime, data, bills, gift cards) across 170+ countries, powered by Celo blockchain.',
    provider: {
      organization: 'Toppa',
      url: apiUrl,
    },
    version: '2.0.0',

    // Per spec: supportedInterfaces lists where clients can reach this agent
    supportedInterfaces: [
      {
        url: `${apiUrl}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],

    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },

    // Per spec: MIME types for input/output
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],

    skills: [
      {
        id: 'send-airtime',
        name: 'Send Airtime',
        description: 'Send mobile airtime top-up to any phone number across 170+ countries. Auto-detects operator from phone number.',
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
        tags: ['airtime', 'mobile', 'top-up', 'paid'],
        examples: ['Send $5 airtime to +2348147658721 in Nigeria'],
      },
      {
        id: 'send-data',
        name: 'Send Data Bundle',
        description: 'Send mobile data bundle to any phone number across 170+ countries.',
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
        tags: ['data', 'mobile', 'bundle', 'paid'],
        examples: ['Send 5GB data to +254712345678 in Kenya'],
      },
      {
        id: 'pay-bill',
        name: 'Pay Utility Bill',
        description: 'Pay electricity, water, TV, or internet bills.',
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
        tags: ['bill', 'utility', 'electricity', 'water', 'tv', 'internet', 'paid'],
        examples: ['Pay my DStv bill for account 1234567890'],
      },
      {
        id: 'buy-gift-card',
        name: 'Buy Gift Card',
        description: 'Purchase gift cards from 300+ brands (Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, etc.).',
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
        tags: ['gift-card', 'shopping', 'paid'],
        examples: ['Buy a $25 Steam gift card'],
      },
      {
        id: 'discover-services',
        name: 'Discover Services',
        description: 'Browse available operators, data plans, billers, gift cards, and promotions by country. No payment required.',
        inputModes: ['text/plain'],
        outputModes: ['application/json'],
        tags: ['discovery', 'operators', 'billers', 'gift-cards', 'free'],
        examples: ['What mobile operators are available in Nigeria?'],
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
        description: 'MCP endpoint for direct tool invocation (12 tools)',
      },
    },
  };
}
