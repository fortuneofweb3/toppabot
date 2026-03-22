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

export async function getScheduledTaskById(taskId: string): Promise<ScheduledTask | null> {
  const col = await collection();
  return col.findOne({ _id: new ObjectId(taskId) });
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

/**
 * Get all pending scheduled tasks for a chatId (admin: list group tasks).
 */
export async function getScheduledTasksByChatId(chatId: number): Promise<ScheduledTask[]> {
  const col = await collection();
  return col.find({ chatId, status: 'pending' }).sort({ scheduledAt: 1 }).toArray();
}

/**
 * Admin cancel — no userId check (admin authorized by caller).
 */
export async function adminCancelScheduledTask(taskId: string): Promise<boolean> {
  const col = await collection();
  const result = await col.updateOne(
    { _id: new ObjectId(taskId), status: 'pending' },
    { $set: { status: 'cancelled' } },
  );
  return result.modifiedCount > 0;
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
  if (_recurringInterval) {
    clearInterval(_recurringInterval);
    _recurringInterval = null;
  }
}

// ─── Recurring Tasks ─────────────────────────────────────────────────────

export interface RecurringTask {
  _id?: ObjectId;
  userId: string;
  chatId: number;
  description: string;
  toolName: string;
  toolArgs: Record<string, any>;
  productAmount: number;
  recurrence: {
    frequency: 'daily' | 'weekly' | 'monthly';
    dayOfWeek?: number;    // 0=Sun, 1=Mon, ..., 6=Sat (for weekly)
    dayOfMonth?: number;   // 1-31 (for monthly)
    time: string;          // "HH:MM" in user's timezone
  };
  timezone: string;        // IANA timezone e.g. "Africa/Lagos"
  nextDueAt: Date;         // UTC
  lastExecutedAt?: Date;
  failureCount: number;
  maxFailures: number;     // Disable after N consecutive failures (default 3)
  enabled: boolean;
  createdAt: Date;
}

let _recurringCollection: Collection<RecurringTask> | null = null;

async function recurringCollection(): Promise<Collection<RecurringTask>> {
  if (_recurringCollection) return _recurringCollection;
  const db = await getDb();
  _recurringCollection = db.collection<RecurringTask>('recurring_tasks');
  await _recurringCollection.createIndex({ userId: 1, enabled: 1 });
  await _recurringCollection.createIndex({ nextDueAt: 1, enabled: 1 });
  return _recurringCollection;
}

/**
 * Calculate the next due date based on recurrence rules.
 */
function calculateNextDueDate(
  recurrence: RecurringTask['recurrence'],
  timezone: string,
  after: Date = new Date(),
): Date {
  const { frequency, dayOfWeek, dayOfMonth, time } = recurrence;
  const [hours, minutes] = time.split(':').map(Number);

  // Build the next candidate date in the user's timezone
  // Start from "after" and find the next valid occurrence
  const now = after;

  // Get the current date in the user's timezone
  const tzOptions: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const parts = new Intl.DateTimeFormat('en-CA', tzOptions).formatToParts(now);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '0';
  let year = parseInt(getPart('year'));
  let month = parseInt(getPart('month')) - 1; // 0-indexed
  let day = parseInt(getPart('day'));
  const currentHour = parseInt(getPart('hour'));
  const currentMinute = parseInt(getPart('minute'));

  // Get day of week in user's timezone
  const currentDow = new Date(
    Date.UTC(year, month, day, 12) // Use noon UTC to avoid DST issues
  ).getDay();

  if (frequency === 'daily') {
    // Today if time hasn't passed, otherwise tomorrow
    if (currentHour > hours || (currentHour === hours && currentMinute >= minutes)) {
      day++;
    }
  } else if (frequency === 'weekly' && dayOfWeek !== undefined) {
    let daysUntil = (dayOfWeek - currentDow + 7) % 7;
    if (daysUntil === 0 && (currentHour > hours || (currentHour === hours && currentMinute >= minutes))) {
      daysUntil = 7;
    }
    day += daysUntil;
  } else if (frequency === 'monthly' && dayOfMonth !== undefined) {
    const targetDay = Math.min(dayOfMonth, 28); // Clamp to avoid Feb issues
    if (day > targetDay || (day === targetDay && (currentHour > hours || (currentHour === hours && currentMinute >= minutes)))) {
      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }
    day = targetDay;
  }

  // Build the target datetime string and convert to UTC
  // Use a temporary Date to get the UTC offset for the target timezone
  const localStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

  // Parse in the user's timezone by creating a date and adjusting
  const targetLocal = new Date(localStr + 'Z'); // Treat as UTC first
  const utcFromLocal = new Date(localStr); // Parse as local (server TZ)

  // Get the timezone offset for the target date
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const formatted = formatter.format(targetLocal);
    const match = formatted.match(/GMT([+-]\d{1,2}):?(\d{2})?/);
    if (match) {
      const offsetHours = parseInt(match[1]);
      const offsetMinutes = parseInt(match[2] || '0');
      const totalOffsetMs = (offsetHours * 60 + (offsetHours >= 0 ? offsetMinutes : -offsetMinutes)) * 60 * 1000;
      return new Date(targetLocal.getTime() - totalOffsetMs);
    }
  } catch {
    // Fallback — just return the naive UTC date
  }

  return targetLocal;
}

/**
 * Create a recurring task
 */
export async function createRecurringTask(
  task: Omit<RecurringTask, '_id' | 'createdAt' | 'failureCount' | 'enabled' | 'nextDueAt'>,
): Promise<string> {
  const col = await recurringCollection();
  const nextDueAt = calculateNextDueDate(task.recurrence, task.timezone);
  const result = await col.insertOne({
    ...task,
    nextDueAt,
    failureCount: 0,
    enabled: true,
    createdAt: new Date(),
  });
  return result.insertedId.toString();
}

/**
 * Get all active recurring tasks for a user
 */
export async function getUserRecurringTasks(userId: string): Promise<RecurringTask[]> {
  const col = await recurringCollection();
  return col.find({ userId, enabled: true }).sort({ createdAt: 1 }).toArray();
}

export async function getRecurringTaskById(taskId: string): Promise<RecurringTask | null> {
  const col = await recurringCollection();
  return col.findOne({ _id: new ObjectId(taskId) });
}

/**
 * Get all active recurring tasks for a chatId (admin: list group tasks).
 */
export async function getRecurringTasksByChatId(chatId: number): Promise<RecurringTask[]> {
  const col = await recurringCollection();
  return col.find({ chatId, enabled: true }).sort({ createdAt: 1 }).toArray();
}

/**
 * Admin cancel recurring — no userId check (admin authorized by caller).
 */
export async function adminCancelRecurringTask(taskId: string): Promise<boolean> {
  const col = await recurringCollection();
  const result = await col.updateOne(
    { _id: new ObjectId(taskId), enabled: true },
    { $set: { enabled: false } },
  );
  return result.modifiedCount > 0;
}

/**
 * Cancel a recurring task
 */
export async function cancelRecurringTask(taskId: string, userId: string): Promise<boolean> {
  const col = await recurringCollection();
  const result = await col.updateOne(
    { _id: new ObjectId(taskId), userId, enabled: true },
    { $set: { enabled: false } },
  );
  return result.modifiedCount > 0;
}

/**
 * Get due recurring tasks (nextDueAt <= now, enabled = true)
 */
async function getDueRecurringTasks(): Promise<RecurringTask[]> {
  const col = await recurringCollection();
  return col.find({
    enabled: true,
    nextDueAt: { $lte: new Date() },
  }).toArray();
}

/**
 * After executing a recurring task, calculate and set the next due date.
 * On failure, increment failure count and disable if maxFailures reached.
 */
async function advanceRecurringTask(taskId: ObjectId, success: boolean): Promise<void> {
  const col = await recurringCollection();
  const task = await col.findOne({ _id: taskId });
  if (!task) return;

  if (success) {
    const nextDueAt = calculateNextDueDate(task.recurrence, task.timezone);
    await col.updateOne(
      { _id: taskId },
      {
        $set: {
          nextDueAt,
          lastExecutedAt: new Date(),
          failureCount: 0,
        },
      },
    );
  } else {
    const newFailureCount = task.failureCount + 1;
    const shouldDisable = newFailureCount >= task.maxFailures;
    await col.updateOne(
      { _id: taskId },
      {
        $set: {
          lastExecutedAt: new Date(),
          failureCount: newFailureCount,
          ...(shouldDisable ? { enabled: false } : {}),
          // Still advance to next due date even on failure
          nextDueAt: calculateNextDueDate(task.recurrence, task.timezone),
        },
      },
    );
    if (shouldDisable) {
      console.log(`[Scheduler] Recurring task ${taskId} disabled after ${newFailureCount} consecutive failures`);
    }
  }
}

let _recurringInterval: NodeJS.Timeout | null = null;

/**
 * Start the recurring tasks executor — runs alongside the one-time scheduler.
 * Uses the same callback for task execution.
 */
export async function startRecurringScheduler(onTaskDue: (task: ScheduledTask) => Promise<void>) {
  _recurringInterval = setInterval(async () => {
    try {
      const dueTasks = await getDueRecurringTasks();
      for (const recurring of dueTasks) {
        // Convert to a one-time ScheduledTask for the execution callback
        const oneTimeTask: ScheduledTask = {
          _id: recurring._id,
          userId: recurring.userId,
          chatId: recurring.chatId,
          description: recurring.description,
          toolName: recurring.toolName,
          toolArgs: recurring.toolArgs,
          productAmount: recurring.productAmount,
          scheduledAt: recurring.nextDueAt,
          status: 'executing',
          createdAt: recurring.createdAt,
        };

        try {
          await onTaskDue(oneTimeTask);
          await advanceRecurringTask(recurring._id!, true);
        } catch (err: any) {
          console.error(`[Scheduler] Recurring task ${recurring._id} failed:`, err.message);
          await advanceRecurringTask(recurring._id!, false);
        }
      }
    } catch (err: any) {
      console.error('[Scheduler] Recurring poll error:', err.message);
    }
  }, 60 * 1000); // Check every minute

  console.log('Recurring task scheduler started (checking every 60s)');
}
