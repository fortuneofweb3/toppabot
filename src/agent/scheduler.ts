import { Collection, ObjectId } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

/**
 * Scheduled Tasks — MongoDB-backed task scheduler
 *
 * Users can say things like:
 * - "Send 500 naira airtime to +234... at 5pm"
 * - "Pay my DStv bill every month on the 1st"
 * - "Remind me to buy a Steam gift card tomorrow"
 *
 * The agent detects scheduling intent and calls schedule_task tool.
 * A timer checks every minute for due tasks and executes them.
 */

export interface ScheduledTask {
  _id?: ObjectId;
  userId: string;
  chatId: number;
  description: string;
  toolName: string;
  toolArgs: Record<string, any>;
  productAmount: number;
  scheduledAt: Date;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  executedAt?: Date;
  error?: string;
  resultSummary?: string;
}

let _collection: Collection<ScheduledTask> | null = null;

async function collection(): Promise<Collection<ScheduledTask>> {
  if (_collection) return _collection;
  const db = await getDb();
  _collection = db.collection<ScheduledTask>('scheduled_tasks');

  await _collection.createIndex({ userId: 1, status: 1 });
  await _collection.createIndex({ scheduledAt: 1, status: 1 });
  // Auto-delete completed/failed tasks after 30 days
  await _collection.createIndex(
    { executedAt: 1 },
    { expireAfterSeconds: 30 * 86400, partialFilterExpression: { status: { $in: ['completed', 'failed'] } } },
  );
  return _collection;
}

/**
 * Create a scheduled task
 */
export async function createScheduledTask(task: Omit<ScheduledTask, '_id' | 'createdAt' | 'status'>): Promise<string> {
  const col = await collection();
  const result = await col.insertOne({
    ...task,
    status: 'pending',
    createdAt: new Date(),
  });
  return result.insertedId.toString();
}

/**
 * Get all pending tasks for a user
 */
export async function getUserScheduledTasks(userId: string): Promise<ScheduledTask[]> {
  const col = await collection();
  return col.find({ userId, status: 'pending' }).sort({ scheduledAt: 1 }).toArray();
}

/**
 * Cancel a scheduled task
 */
export async function cancelScheduledTask(taskId: string, userId: string): Promise<boolean> {
  const col = await collection();
  const result = await col.updateOne(
    { _id: new ObjectId(taskId), userId, status: 'pending' },
    { $set: { status: 'cancelled' } },
  );
  return result.modifiedCount > 0;
}

/**
 * Get due tasks (scheduledAt <= now, status = pending)
 */
export async function getDueTasks(): Promise<ScheduledTask[]> {
  const col = await collection();
  return col.find({
    status: 'pending',
    scheduledAt: { $lte: new Date() },
  }).toArray();
}

/**
 * Mark task as executing (prevents double-execution)
 */
export async function markTaskExecuting(taskId: ObjectId): Promise<boolean> {
  const col = await collection();
  const result = await col.updateOne(
    { _id: taskId, status: 'pending' },
    { $set: { status: 'executing', executedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

/**
 * Mark task completed
 */
export async function markTaskCompleted(taskId: ObjectId, resultSummary: string): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { _id: taskId },
    { $set: { status: 'completed', executedAt: new Date(), resultSummary } },
  );
}

/**
 * Mark task failed
 */
export async function markTaskFailed(taskId: ObjectId, error: string): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { _id: taskId },
    { $set: { status: 'failed', executedAt: new Date(), error } },
  );
}

/**
 * Check if a user had a scheduled task execute recently (within the last N minutes).
 * Used by the heartbeat to avoid duplicate messaging — scheduler already notified the user.
 */
export async function hasRecentTaskExecution(userId: string, withinMinutes = 30): Promise<boolean> {
  const col = await collection();
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
  const count = await col.countDocuments({
    userId,
    status: { $in: ['executing', 'completed', 'failed'] },
    executedAt: { $gte: cutoff },
  });
  return count > 0;
}

// ─── Task Executor (runs every minute) ───

let _executorInterval: NodeJS.Timeout | null = null;
let _onTaskDue: ((task: ScheduledTask) => Promise<void>) | null = null;

/**
 * Start the scheduler — checks for due tasks every 60 seconds.
 * Caller provides the execution callback (handles payment + tool execution + notification).
 */
export async function startScheduler(onTaskDue: (task: ScheduledTask) => Promise<void>) {
  _onTaskDue = onTaskDue;

  // Recovery: fail any tasks stuck in 'executing' from a previous crash/restart.
  // If a task was executing when the process died, it never got marked completed/failed.
  try {
    const col = await collection();
    const stuckCutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const result = await col.updateMany(
      { status: 'executing', executedAt: { $lt: stuckCutoff } },
      { $set: { status: 'failed', error: 'Task stuck in executing state (server restarted)' } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[Scheduler] Recovered ${result.modifiedCount} stuck executing task(s)`);
    }
  } catch (err: any) {
    console.error('[Scheduler] Recovery query failed:', err.message);
  }

  _executorInterval = setInterval(async () => {
    try {
      const dueTasks = await getDueTasks();
      for (const task of dueTasks) {
        // Atomically claim the task
        const claimed = await markTaskExecuting(task._id!);
        if (!claimed) continue; // Another instance got it

        try {
          if (!_onTaskDue) {
            console.error('[Scheduler] Handler not initialized, failing task:', task._id);
            await markTaskFailed(task._id!, 'Handler not initialized');
            continue;
          }
          await _onTaskDue(task);
        } catch (err: any) {
          console.error(`[Scheduler] Task ${task._id} failed:`, err.message);
          await markTaskFailed(task._id!, err.message);
        }
      }
    } catch (err: any) {
      console.error('[Scheduler] Poll error:', err.message);
    }
  }, 60 * 1000); // Check every minute

  console.log('Task scheduler started (checking every 60s)');
}

/**
 * Stop the scheduler (for graceful shutdown)
 */
export function stopScheduler() {
  if (_executorInterval) {
    clearInterval(_executorInterval);
    _executorInterval = null;
  }
}
