/**
 * Shared group @mention infrastructure for Telegram and WhatsApp.
 *
 * Tracks recent messages per group chat so the bot has conversational context
 * when @mentioned. Both platforms use the same underlying data structures.
 */

// ─────────────────────────────────────────────────
// Group Message History
// ─────────────────────────────────────────────────

export interface GroupMsg {
  userId: string;
  text: string;
  ts: number;
}

const groupMsgHistory = new Map<string, GroupMsg[]>();

/** Record a message in a group's history buffer. Keeps last 20 messages. */
export function recordGroupMsg(groupId: string, userId: string, text: string): void {
  let h = groupMsgHistory.get(groupId);
  if (!h) { h = []; groupMsgHistory.set(groupId, h); }
  h.push({ userId, text, ts: Date.now() });
  if (h.length > 20) h.splice(0, h.length - 20);
}

/** Get the N most recent messages from a group's history. */
export function getRecentGroupMsgs(groupId: string, count = 5): GroupMsg[] {
  return (groupMsgHistory.get(groupId) || []).slice(-count);
}

// ─────────────────────────────────────────────────
// Group Context Builder
// ─────────────────────────────────────────────────

/**
 * Build a context string with recent group messages + an optional quoted/replied-to message.
 * Used to give the agent conversational context when @mentioned in a group.
 */
export function buildGroupContext(groupId: string, quotedText?: string): string {
  const parts: string[] = [];
  const recent = getRecentGroupMsgs(groupId, 5);
  if (recent.length > 0) {
    parts.push('Recent group messages:');
    for (const m of recent) parts.push(`- ${m.text.slice(0, 200)}`);
  }
  if (quotedText) {
    parts.push(`\nReplied-to message: "${quotedText.slice(0, 500)}"`);
  }
  return parts.length > 0 ? `[Group Context]\n${parts.join('\n')}` : '';
}

// ─────────────────────────────────────────────────
// Rate Limiting (shared between Telegram & WhatsApp)
// ─────────────────────────────────────────────────

export interface UserRateLimit {
  requestCount: number;
  lastReset: number;
  totalSpent: number;
  spendingResetDate: number;
}

export const RATE_LIMIT_WINDOW = 60 * 1000;       // 1 minute
export const MAX_REQUESTS_PER_WINDOW = 20;         // 20 req/min
export const DAILY_SPENDING_LIMIT = 20;            // $20/day for unverified users
export const VERIFIED_SPENDING_LIMIT = 200;        // $200/day for Self-verified users
export const SPENDING_RESET_WINDOW = 24 * 60 * 60 * 1000;

/**
 * Check rate limit for a user. Returns true if allowed, false if rate limited.
 * Mutates the limit entry in place.
 */
export function checkRateLimit(
  limits: Map<string, UserRateLimit>,
  userId: string,
): { allowed: boolean; limit: UserRateLimit } {
  const now = Date.now();
  let limit = limits.get(userId);
  if (!limit) {
    limit = { requestCount: 0, lastReset: now, totalSpent: 0, spendingResetDate: now + SPENDING_RESET_WINDOW };
    limits.set(userId, limit);
  }

  // Reset counters if window expired
  if (now - limit.lastReset > RATE_LIMIT_WINDOW) {
    limit.requestCount = 0;
    limit.lastReset = now;
  }
  if (now > limit.spendingResetDate) {
    limit.totalSpent = 0;
    limit.spendingResetDate = now + SPENDING_RESET_WINDOW;
  }

  limit.requestCount++;
  const allowed = limit.requestCount <= MAX_REQUESTS_PER_WINDOW;
  return { allowed, limit };
}
