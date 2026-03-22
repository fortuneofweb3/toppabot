/**
 * Group Wallet Infrastructure — MongoDB-backed group management.
 *
 * Each Telegram/WhatsApp group can have a shared wallet.
 * Admin (whoever runs /group enable first) controls spending.
 * Members can contribute cUSD from their personal wallets.
 *
 * Group wallet is a regular Celo wallet managed by WalletManager,
 * keyed as "group_<groupId>" in the wallet store.
 */

import { Collection, ObjectId } from 'mongodb';
import { getDb } from '../wallet/mongo-store';
import { WalletManager } from '../wallet/manager';

// ─── Types ───────────────────────────────────────────────────

export interface Group {
  _id?: ObjectId;
  groupId: string;            // Telegram chat ID or WhatsApp group JID
  platform: 'telegram' | 'whatsapp';
  name: string;
  walletId: string;           // Wallet key: "group_<groupId>"
  walletAddress: string;      // Celo address
  adminUserId: string;        // User who enabled the group wallet
  members: string[];          // User IDs who have contributed
  pollThreshold: number;      // 0.0–1.0, default 0.7 (70% approval needed)
  pollingEnabled: boolean;    // default true — admin can toggle off to let everyone spend directly
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupPoll {
  _id?: ObjectId;
  pollId: string;             // Unique poll ID (poll_<random>)
  groupId: string;
  chatId: number;             // Telegram chat ID (for sending results)
  messageId?: number;         // Telegram message ID (for pinning/unpinning)
  tgPollId?: string;          // Telegram native poll ID (for poll_answer tracking)
  createdBy: string;          // User who initiated
  description: string;        // Human-readable description
  action: {
    service: string;          // send_airtime, send_data, etc.
    amount: number;
    details: Record<string, any>;
  };
  threshold: number;          // Snapshot of group threshold at creation
  totalMembers: number;       // Snapshot of member count at creation
  yesVotes: string[];         // User IDs who voted yes
  noVotes: string[];          // User IDs who voted no
  status: 'active' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  createdAt: Date;
  expiresAt: Date;            // Auto-expire after 24h
}

export interface GroupTransaction {
  _id?: ObjectId;
  groupId: string;
  userId: string;
  type: 'contribution' | 'withdrawal' | 'spend';
  amount: number;             // cUSD
  txHash: string;
  description: string;
  createdAt: Date;
}

// ─── Store ───────────────────────────────────────────────────

const GROUPS_COLLECTION = 'groups';
const TX_COLLECTION = 'group_transactions';
const POLLS_COLLECTION = 'group_polls';

let _groupCol: Collection<Group> | null = null;
let _txCol: Collection<GroupTransaction> | null = null;
let _pollCol: Collection<GroupPoll> | null = null;
let _indexesCreated = false;

async function getGroupCollection(): Promise<Collection<Group>> {
  if (_groupCol && _indexesCreated) return _groupCol;

  const db = await getDb();
  _groupCol = db.collection<Group>(GROUPS_COLLECTION);

  if (!_indexesCreated) {
    await Promise.all([
      _groupCol.createIndex({ groupId: 1 }, { unique: true }),
      _groupCol.createIndex({ adminUserId: 1 }),
      _groupCol.createIndex({ members: 1 }),
    ]);

    _txCol = db.collection<GroupTransaction>(TX_COLLECTION);
    await Promise.all([
      _txCol.createIndex({ groupId: 1, createdAt: -1 }),
      _txCol.createIndex({ groupId: 1, userId: 1 }),
    ]);

    _pollCol = db.collection<GroupPoll>(POLLS_COLLECTION);
    await Promise.all([
      _pollCol.createIndex({ pollId: 1 }, { unique: true }),
      _pollCol.createIndex({ groupId: 1, status: 1 }),
      _pollCol.createIndex({ tgPollId: 1 }, { sparse: true }),
      _pollCol.createIndex({ groupId: 1, createdAt: -1 }), // For poll history queries
    ]);

    _indexesCreated = true;
  }

  return _groupCol;
}

async function getTxCollection(): Promise<Collection<GroupTransaction>> {
  if (_txCol) return _txCol;
  await getGroupCollection(); // Ensures indexes + collections are initialized
  return _txCol!;
}

async function getPollCollection(): Promise<Collection<GroupPoll>> {
  if (_pollCol) return _pollCol;
  await getGroupCollection(); // Ensures indexes + collections are initialized
  return _pollCol!;
}

// ─── Group CRUD ──────────────────────────────────────────────

/**
 * Enable a group wallet. Creates the group doc + Celo wallet.
 * Only the first caller becomes admin.
 */
export async function enableGroup(
  groupId: string,
  platform: 'telegram' | 'whatsapp',
  name: string,
  adminUserId: string,
  walletManager: WalletManager,
): Promise<Group> {
  const col = await getGroupCollection();

  // Check if already exists
  const existing = await col.findOne({ groupId });
  if (existing) {
    return existing;
  }

  // Create a wallet for the group
  const walletId = `group_${groupId}`;
  const { address } = await walletManager.getOrCreateWallet(walletId);

  const group: Group = {
    groupId,
    platform,
    name,
    walletId,
    walletAddress: address,
    adminUserId,
    members: [adminUserId],
    pollThreshold: 0.7,
    pollingEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await col.insertOne(group);
  return group;
}

/**
 * Get a group by its chat ID.
 */
export async function getGroup(groupId: string): Promise<Group | null> {
  const col = await getGroupCollection();
  return col.findOne({ groupId });
}

/**
 * Check if a user is the group admin.
 */
export function isGroupAdmin(group: Group, userId: string): boolean {
  return group.adminUserId === userId;
}

/**
 * Get all groups where a user is admin or member.
 */
export async function getUserGroups(userId: string): Promise<Group[]> {
  const col = await getGroupCollection();
  return col.find({
    $or: [{ adminUserId: userId }, { members: userId }],
  }).toArray();
}

/**
 * Get group wallet cUSD balance.
 */
export async function getGroupBalance(
  group: Group,
  walletManager: WalletManager,
): Promise<{ balance: string; address: string }> {
  const { balance, address } = await walletManager.getBalance(group.walletId);
  return { balance, address };
}

// ─── Contributions ───────────────────────────────────────────

/**
 * Contribute cUSD from personal wallet to group wallet.
 * Uses WalletManager.withdraw() to send from personal → group address.
 */
export async function contributeToGroup(
  group: Group,
  userId: string,
  amount: number,
  walletManager: WalletManager,
): Promise<{ txHash: string }> {
  // Withdraw from personal wallet to group wallet address
  const result = await walletManager.withdraw(userId, group.walletAddress, amount);

  // Record transaction
  await recordTransaction(group.groupId, userId, 'contribution', amount, result.txHash, `Contributed ${amount} cUSD`);

  // Add user to members if not already
  const col = await getGroupCollection();
  await col.updateOne(
    { groupId: group.groupId },
    {
      $addToSet: { members: userId },
      $set: { updatedAt: new Date() },
    },
  );

  return { txHash: result.txHash };
}

/**
 * Withdraw from group wallet to an external address (admin only).
 */
export async function groupWithdraw(
  group: Group,
  amount: number,
  toAddress: string,
  walletManager: WalletManager,
): Promise<{ txHash: string }> {
  const result = await walletManager.withdraw(group.walletId, toAddress, amount);

  await recordTransaction(group.groupId, group.adminUserId, 'withdrawal', amount, result.txHash, `Withdrew ${amount} cUSD to ${toAddress.slice(0, 10)}...`);

  return { txHash: result.txHash };
}

// ─── Transactions ────────────────────────────────────────────

/**
 * Record a group transaction.
 */
export async function recordTransaction(
  groupId: string,
  userId: string,
  type: 'contribution' | 'withdrawal' | 'spend',
  amount: number,
  txHash: string,
  description: string,
): Promise<void> {
  const col = await getTxCollection();
  await col.insertOne({
    groupId,
    userId,
    type,
    amount,
    txHash,
    description,
    createdAt: new Date(),
  });
}

/**
 * Get recent group transactions.
 */
export async function getGroupTransactions(
  groupId: string,
  limit = 10,
): Promise<GroupTransaction[]> {
  const col = await getTxCollection();
  return col.find({ groupId }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Get per-member contribution totals.
 */
export async function getMemberContributions(
  groupId: string,
): Promise<Array<{ userId: string; total: number }>> {
  const col = await getTxCollection();
  const result = await col.aggregate([
    { $match: { groupId, type: 'contribution' } },
    { $group: { _id: '$userId', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
  ]).toArray();

  return result.map(r => ({ userId: r._id as string, total: r.total as number }));
}

// ─── Poll Settings ───────────────────────────────────────────

/**
 * Update group poll approval threshold (admin only).
 */
export async function setPollThreshold(groupId: string, threshold: number): Promise<void> {
  const col = await getGroupCollection();
  await col.updateOne(
    { groupId },
    { $set: { pollThreshold: threshold, updatedAt: new Date() } },
  );
}

// ─── Polls ───────────────────────────────────────────────────

function generatePollId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `poll_${Date.now()}_${rand}`;
}

/**
 * Create a new group poll for a spending decision.
 */
export async function createGroupPoll(params: {
  groupId: string;
  chatId: number;
  createdBy: string;
  description: string;
  service: string;
  amount: number;
  details: Record<string, any>;
  threshold: number;
  totalMembers: number;
}): Promise<GroupPoll> {
  const col = await getPollCollection();

  const poll: GroupPoll = {
    pollId: generatePollId(),
    groupId: params.groupId,
    chatId: params.chatId,
    createdBy: params.createdBy,
    description: params.description,
    action: {
      service: params.service,
      amount: params.amount,
      details: params.details,
    },
    threshold: params.threshold,
    totalMembers: params.totalMembers,
    yesVotes: [],
    noVotes: [],
    status: 'active',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
  };

  await col.insertOne(poll);
  return poll;
}

/**
 * Store the Telegram message ID and poll ID for tracking.
 */
export async function setPollMessageInfo(
  pollId: string,
  messageId: number,
  tgPollId: string,
): Promise<void> {
  const col = await getPollCollection();
  await col.updateOne(
    { pollId },
    { $set: { messageId, tgPollId } },
  );
}

/**
 * Get an active poll by Telegram native poll ID.
 */
export async function getPollByTgPollId(tgPollId: string): Promise<GroupPoll | null> {
  const col = await getPollCollection();
  return col.findOne({ tgPollId, status: 'active' });
}

/**
 * Get an active poll by our internal poll ID.
 */
export async function getPollById(pollId: string): Promise<GroupPoll | null> {
  const col = await getPollCollection();
  return col.findOne({ pollId });
}

/**
 * Get all active polls for a group. Auto-expires stale polls.
 */
export async function getActivePolls(groupId: string): Promise<GroupPoll[]> {
  const col = await getPollCollection();

  // Auto-expire polls past their expiresAt
  await col.updateMany(
    { groupId, status: 'active', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired' as const } },
  );

  return col.find({ groupId, status: 'active' }).sort({ createdAt: -1 }).toArray();
}

/**
 * Get poll history for a group (all polls, including expired/completed).
 */
export async function getPollHistory(groupId: string, limit = 20): Promise<GroupPoll[]> {
  const col = await getPollCollection();
  return col.find({ groupId }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Record a vote on a poll. Returns the updated vote counts and whether threshold is met.
 */
export async function recordPollVote(
  pollId: string,
  userId: string,
  vote: 'yes' | 'no',
): Promise<{ yesCount: number; noCount: number; totalMembers: number; threshold: number; status: 'active' | 'approved' | 'rejected' } | null> {
  const col = await getPollCollection();
  const poll = await col.findOne({ pollId, status: 'active' });
  if (!poll) return null;

  // Only group members (contributors) can vote
  const group = await getGroup(poll.groupId);
  if (group && !group.members.includes(userId)) return null;

  // Remove from both arrays (in case of vote change), then add to the right one
  const update: any = {
    $pull: { yesVotes: userId, noVotes: userId },
  };
  await col.updateOne({ pollId }, update);

  // Add to the correct array
  if (vote === 'yes') {
    await col.updateOne({ pollId }, { $addToSet: { yesVotes: userId } });
  } else {
    await col.updateOne({ pollId }, { $addToSet: { noVotes: userId } });
  }

  // Re-fetch to get accurate counts
  const updated = await col.findOne({ pollId });
  if (!updated) return null;

  const yesCount = updated.yesVotes.length;
  const noCount = updated.noVotes.length;
  const yesRatio = yesCount / updated.totalMembers;
  const noRatio = noCount / updated.totalMembers;

  // Check if threshold met
  let status: 'active' | 'approved' | 'rejected' = 'active';
  if (yesRatio >= updated.threshold) {
    status = 'approved';
    await col.updateOne({ pollId }, { $set: { status: 'approved' } });
  } else if (noRatio > (1 - updated.threshold)) {
    // Impossible to reach threshold — reject
    status = 'rejected';
    await col.updateOne({ pollId }, { $set: { status: 'rejected' } });
  }

  return { yesCount, noCount, totalMembers: updated.totalMembers, threshold: updated.threshold, status };
}

/**
 * Close an active poll. Returns true if a poll was actually updated.
 */
export async function closePoll(pollId: string, reason: 'expired' | 'rejected' | 'cancelled' | 'approved'): Promise<boolean> {
  const col = await getPollCollection();
  const result = await col.updateOne({ pollId, status: 'active' }, { $set: { status: reason } });
  return result.modifiedCount > 0;
}

/**
 * Toggle polling on/off for a group (admin only).
 */
export async function setPollingEnabled(groupId: string, enabled: boolean): Promise<void> {
  const col = await getGroupCollection();
  await col.updateOne({ groupId }, { $set: { pollingEnabled: enabled, updatedAt: new Date() } });
}

/**
 * Get the most recent active poll for a group.
 */
export async function getMostRecentActivePoll(groupId: string): Promise<GroupPoll | null> {
  const col = await getPollCollection();
  // Auto-expire stale polls first
  await col.updateMany(
    { groupId, status: 'active', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired' as const } },
  );
  return col.findOne({ groupId, status: 'active' }, { sort: { createdAt: -1 } });
}


