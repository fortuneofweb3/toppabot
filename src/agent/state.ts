import { BaseMessage } from "@langchain/core/messages";

/**
 * Agent State - Tracks the conversation and agent context
 */
export interface AgentState {
  messages: BaseMessage[];
  userAddress?: string;
  amount?: number;
  currency?: string;
  country?: string;
  action?: 'bank' | 'mobile_money' | 'bill' | 'card' | 'airtime';
  recipientDetails?: Record<string, string>;
  billType?: 'electricity' | 'cable' | 'data';
  provider?: string;
  rate?: number;
  selfClawVerified?: boolean;
  transactionHash?: string;
  error?: string;
}
