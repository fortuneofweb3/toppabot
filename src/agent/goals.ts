import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

/**
 * User Goals — Persistent standing instructions that make Toppa autonomous
 *
 * Users can set goals/instructions like:
 * - "Always top up my brother +2348147658721 on the 1st of every month with 1000 NGN"
 * - "My mom's DStv account is 1234567890 — never let it expire"
 * - "I prefer MTN for all Nigerian numbers"
 * - "My default country is Nigeria"
 * - "Alert me when there are airtime promos in Nigeria"
 *
 * The agent loads these before every interaction and reasons about them.
 * Combined with conversation memory, this gives the agent persistent context
 * about each user — making it a true personal assistant.
 */

export interface UserGoal {
  userId: string;
  instruction: string;
  category: 'preference' | 'recurring' | 'contact' | 'alert' | 'general';
  createdAt: Date;
  active: boolean;
}

let _collection: Collection<UserGoal> | null = null;

async function collection(): Promise<Collection<UserGoal>> {
  if (_collection) return _collection;
  const db = await getDb();
  _collection = db.collection<UserGoal>('user_goals');
  await _collection.createIndex({ userId: 1, active: 1 });
  return _collection;
}

/**
 * Save a user instruction/goal
 */
const MAX_GOALS_PER_USER = 50;

export async function saveUserGoal(
  userId: string,
  instruction: string,
  category: UserGoal['category'] = 'general',
): Promise<string> {
  const col = await collection();

  // Prevent unbounded growth
  const count = await col.countDocuments({ userId, active: true });
  if (count >= MAX_GOALS_PER_USER) {
    throw new Error(`You have ${MAX_GOALS_PER_USER} saved instructions — remove some old ones first.`);
  }

  const result = await col.insertOne({
    userId,
    instruction,
    category,
    createdAt: new Date(),
    active: true,
  });
  return result.insertedId.toString();
}

/**
 * Get all active goals for a user
 */
export async function getUserGoals(userId: string): Promise<UserGoal[]> {
  const col = await collection();
  return col.find({ userId, active: true }).sort({ createdAt: 1 }).toArray();
}

/**
 * Remove a goal by instruction text match (fuzzy)
 */
export async function removeUserGoal(userId: string, instructionFragment: string): Promise<boolean> {
  const col = await collection();
  const result = await col.updateOne(
    { userId, active: true, instruction: { $regex: instructionFragment, $options: 'i' } },
    { $set: { active: false } },
  );
  return result.modifiedCount > 0;
}

/**
 * Format goals as context string for the system prompt
 */
export async function formatUserContext(userId: string): Promise<string> {
  const goals = await getUserGoals(userId);
  if (goals.length === 0) return '';

  const lines = goals.map((g, i) => `${i + 1}. [${g.category}] ${g.instruction}`);
  return `\nUser's standing instructions:\n${lines.join('\n')}`;
}
