/**
 * Agent State — context passed to the agent for each request
 */
export interface AgentState {
  userAddress?: string;
  amount?: number;
  currency?: string;
  country?: string;
  action?: 'airtime' | 'bill' | 'gift_card' | 'data';
  recipientDetails?: Record<string, string>;
  billType?: 'electricity' | 'water' | 'tv' | 'internet';
  provider?: string;

  // Security & Differentiation
  source?: 'telegram' | 'x402_api' | 'a2a' | 'whatsapp';
  rateLimited?: boolean;

  // Telegram Wallet Context
  walletAddress?: string;
  walletBalance?: string;

  // User Context
  timezone?: string; // IANA timezone e.g. "Africa/Lagos"
  chatId?: number;

  // Group Context
  groupId?: string;  // Telegram chat ID or WhatsApp group JID (set when in group chat)
}
