const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const AGENT_ID = parseInt(process.env.AGENT_ID || '1870', 10);
const CHAIN_ID = 42220; // Celo mainnet
const API_URL = process.env.API_URL || 'https://api.toppa.cc';

const GIVE_FEEDBACK_ABI =
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external';

/**
 * Build reputation metadata block for inclusion in paid service responses.
 * Gives external callers everything they need to submit on-chain feedback.
 */
export function getReputationMeta(serviceType: string) {
  const serviceEndpoint = serviceType === 'airtime' ? '/send-airtime' :
                          serviceType === 'data' ? '/send-data' :
                          serviceType === 'bill_payment' ? '/pay-bill' :
                          serviceType === 'gift_card' ? '/buy-gift-card' : '';
  return {
    agentId: AGENT_ID,
    chainId: CHAIN_ID,
    reputationRegistry: REPUTATION_REGISTRY,
    endpoint: `${API_URL}${serviceEndpoint}`,
    giveFeedbackABI: GIVE_FEEDBACK_ABI,
    suggestedTags: {
      tag1Options: ['delivered', 'fast_delivery', 'value_received', 'reliable', 'failed', 'slow_delivery'],
      tag2: serviceType,
    },
  };
}
