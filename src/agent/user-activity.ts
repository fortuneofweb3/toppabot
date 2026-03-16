import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

/**
 * User Activity Tracker — Lightweight per-user activity tracking
 *
 * Tracks when users were last active, their chat IDs for proactive messaging,
 * and their preferences (country, opt-out flags). Used by the heartbeat engine
 * to decide which users to check on and how to reach them.
 */

export interface UserActivity {
  userId: string;
  chatId: number;
  lastMessageAt: Date;
  lastProactiveAt: Date | null;
  messageCount: number;
  proactiveEnabled: boolean;
  country?: string;
}

let _collection: Collection<UserActivity> | null = null;

async function collection(): Promise<Collection<UserActivity>> {
  if (_collection) return _collection;
  const db = await getDb();
  _collection = db.collection<UserActivity>('user_activity');

  await _collection.createIndex({ userId: 1 }, { unique: true });
  await _collection.createIndex({ lastMessageAt: -1 });
  return _collection;
}

/**
 * Track user activity — called on each incoming message
 */
export async function trackActivity(userId: string, chatId: number): Promise<void> {
  try {
    const col = await collection();
    await col.updateOne(
      { userId },
      {
        $set: { chatId, lastMessageAt: new Date() },
        $inc: { messageCount: 1 },
        $setOnInsert: { proactiveEnabled: true, lastProactiveAt: null },
      },
      { upsert: true },
    );
  } catch (error) {
    console.error('[Activity] Failed to track:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get users active within the last N days (for heartbeat checks)
 */
export async function getActiveUsers(withinDays: number = 7): Promise<UserActivity[]> {
  try {
    const col = await collection();
    const cutoff = new Date(Date.now() - withinDays * 86400 * 1000);
    return col.find({
      lastMessageAt: { $gte: cutoff },
      proactiveEnabled: true,
    }).toArray();
  } catch (error) {
    console.error('[Activity] Failed to get active users:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Record when we last sent a proactive message to a user
 */
export async function updateLastProactive(userId: string): Promise<void> {
  try {
    const col = await collection();
    await col.updateOne({ userId }, { $set: { lastProactiveAt: new Date() } });
  } catch (error) {
    console.error('[Activity] Failed to update proactive:', error instanceof Error ? error.message : error);
  }
}

/**
 * Check if we can send a proactive message (respects cooldown)
 */
export async function canSendProactive(userId: string, cooldownHours: number = 4): Promise<boolean> {
  try {
    const col = await collection();
    const user = await col.findOne({ userId });
    if (!user || !user.proactiveEnabled) return false;
    if (!user.lastProactiveAt) return true;

    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    return Date.now() - user.lastProactiveAt.getTime() > cooldownMs;
  } catch (error) {
    return false;
  }
}

/**
 * Toggle proactive messages on/off for a user
 */
export async function setProactiveEnabled(userId: string, enabled: boolean): Promise<void> {
  try {
    const col = await collection();
    await col.updateOne({ userId }, { $set: { proactiveEnabled: enabled } });
  } catch (error) {
    console.error('[Activity] Failed to toggle proactive:', error instanceof Error ? error.message : error);
  }
}

/**
 * Store user's country (auto-learned from tool calls)
 */
export async function setUserCountry(userId: string, country: string): Promise<void> {
  try {
    const col = await collection();
    await col.updateOne({ userId }, { $set: { country: country.toUpperCase() } });
  } catch (error) {
    console.error('[Activity] Failed to set country:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get a single user's activity record
 */
export async function getUserActivity(userId: string): Promise<UserActivity | null> {
  try {
    const col = await collection();
    return col.findOne({ userId });
  } catch (error) {
    return null;
  }
}
