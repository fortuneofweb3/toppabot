import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';
import OpenAI from 'openai';

/**
 * Conversation Memory — MongoDB-backed per-user message history
 *
 * Stores the last N messages per user so the agent remembers context:
 * - "Send airtime to my brother" → later "send him data too" (remembers who "him" is)
 * - Remembers user preferences, frequently used numbers, countries, etc.
 * - Survives server restarts (MongoDB)
 * - Auto-prunes old messages to keep storage bounded
 */

interface StoredMessage {
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const MAX_HISTORY_MESSAGES = 6; // Keep last 6 messages (3 turns) — just for pronoun resolution
const HISTORY_TTL_HOURS = 1; // Expire after 1 hour — long-term memory uses save_instruction
const MAX_MESSAGE_LENGTH = 300; // Compact messages — full context lives in save_instruction

let _collection: Collection<StoredMessage> | null = null;

async function collection(): Promise<Collection<StoredMessage>> {
  if (_collection) return _collection;
  const db = await getDb();
  _collection = db.collection<StoredMessage>('conversations');

  // Index for fast per-user lookups + TTL auto-cleanup
  await _collection.createIndex({ userId: 1, timestamp: -1 });
  await _collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: HISTORY_TTL_HOURS * 3600 });
  return _collection;
}

/**
 * Get conversation history for a user (most recent messages first, reversed to chronological)
 */
export async function getConversationHistory(
  userId: string,
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  try {
    const col = await collection();
    const messages = await col
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(MAX_HISTORY_MESSAGES)
      .toArray();

    // Reverse to chronological order
    return messages.reverse().map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  } catch (error) {
    console.error('[Memory] Failed to load history:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Save a user message + assistant response to history
 */
export async function saveConversation(
  userId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    const col = await collection();
    const now = new Date();

    // Truncate messages to prevent storage bloat and context overflow
    const truncUser = userMessage.length > MAX_MESSAGE_LENGTH
      ? userMessage.slice(0, MAX_MESSAGE_LENGTH) + '...'
      : userMessage;
    const truncAssistant = assistantResponse.length > MAX_MESSAGE_LENGTH
      ? assistantResponse.slice(0, MAX_MESSAGE_LENGTH) + '...'
      : assistantResponse;

    await col.insertMany([
      { userId, role: 'user', content: truncUser, timestamp: now },
      { userId, role: 'assistant', content: truncAssistant, timestamp: new Date(now.getTime() + 1) },
    ]);

    // Prune if over limit (keep only the most recent MAX_HISTORY_MESSAGES)
    const count = await col.countDocuments({ userId });
    if (count > MAX_HISTORY_MESSAGES) {
      const oldest = await col
        .find({ userId })
        .sort({ timestamp: -1 })
        .skip(MAX_HISTORY_MESSAGES)
        .limit(1)
        .toArray();

      if (oldest.length > 0) {
        await col.deleteMany({
          userId,
          timestamp: { $lte: oldest[0].timestamp },
        });
      }
    }
  } catch (error) {
    console.error('[Memory] Failed to save:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get a compact summary of recent conversation (for heartbeat — cheaper than full history)
 */
export async function getConversationSummary(userId: string): Promise<string> {
  try {
    const col = await collection();
    const messages = await col
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    if (messages.length === 0) return 'No recent conversations.';

    // Build compact summary from recent messages
    const topics = messages.reverse().map(m => {
      const prefix = m.role === 'user' ? 'User' : 'Toppa';
      // Truncate long messages
      const content = m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content;
      return `${prefix}: ${content}`;
    });

    return `Recent conversation:\n${topics.join('\n')}`;
  } catch (error) {
    return 'No recent conversations.';
  }
}

/**
 * Clear conversation history for a user
 */
export async function clearConversationHistory(userId: string): Promise<void> {
  try {
    const col = await collection();
    await col.deleteMany({ userId });
  } catch (error) {
    console.error('[Memory] Failed to clear:', error instanceof Error ? error.message : error);
  }
}
