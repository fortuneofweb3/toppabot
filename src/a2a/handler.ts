import { Request, Response } from 'express';
import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';
import { runToppaAgent } from '../agent/graph';

/**
 * A2A (Agent-to-Agent Protocol) — JSON-RPC 2.0 Task Handler
 *
 * Follows the A2A spec v1.0: https://a2a-protocol.org
 *
 * Supports:
 * - SendMessage: Submit a natural-language task, routed through the agent
 * - GetTask: Retrieve a task by ID
 * - CancelTask: Cancel a non-terminal task
 *
 * Tasks are stored in MongoDB — survives server restarts.
 */

// ─── A2A Error Codes (per spec) ───

const A2A_ERRORS = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNSUPPORTED_OPERATION: -32004,
} as const;

const TERMINAL_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);

// ─── Task Types ───

interface A2ATask {
  id: string;
  contextId: string;
  status: {
    state: string;
    message?: { role: string; parts: Array<{ text?: string }> };
    timestamp: string;
  };
  history: Array<{ messageId: string; role: string; parts: Array<{ text?: string; mediaType?: string }> }>;
  artifacts: Array<{ artifactId: string; name?: string; parts: Array<{ text?: string; mediaType?: string }> }>;
  metadata?: Record<string, any>;
  _expiresAt?: Date; // TTL field
}

// ─── MongoDB-backed task store ───

const COLLECTION_NAME = 'a2a_tasks';
const TASK_TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_TEXT_LENGTH = 10000;
let _collection: Collection<A2ATask> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<A2ATask>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<A2ATask>(COLLECTION_NAME);

  if (!_indexesCreated) {
    await _collection.createIndex({ id: 1 }, { unique: true });
    // TTL index — MongoDB auto-deletes tasks after 30 minutes
    await _collection.createIndex({ _expiresAt: 1 }, { expireAfterSeconds: 0 });
    _indexesCreated = true;
  }

  return _collection;
}

async function getTask(taskId: string): Promise<A2ATask | null> {
  const col = await getCollection();
  return col.findOne({ id: taskId });
}

async function saveTask(task: A2ATask): Promise<void> {
  const col = await getCollection();
  await col.updateOne(
    { id: task.id },
    { $set: { ...task, _expiresAt: new Date(Date.now() + TASK_TTL_SECONDS * 1000) } },
    { upsert: true },
  );
}

function a2aError(code: number, message: string, data?: any) {
  return { code, message, ...(data ? { data } : {}) };
}

// ─── Main Dispatcher ───

export async function handleA2ARequest(req: Request, res: Response) {
  const { jsonrpc, id, method, params } = req.body;

  if (jsonrpc !== '2.0') {
    res.json({ jsonrpc: '2.0', id: id ?? null, error: a2aError(-32600, 'Invalid JSON-RPC version') });
    return;
  }

  if (typeof method !== 'string') {
    res.json({ jsonrpc: '2.0', id: id ?? null, error: a2aError(-32600, 'Invalid request: method must be a string') });
    return;
  }

  try {
    switch (method) {
      case 'SendMessage':
      case 'message/send':
        await handleSendMessage(id, params, res);
        return;
      case 'GetTask':
      case 'tasks/get':
        await handleGetTask(id, params, res);
        return;
      case 'CancelTask':
      case 'tasks/cancel':
        await handleCancelTask(id, params, res);
        return;
      case 'SendStreamingMessage':
        res.json({ jsonrpc: '2.0', id, error: a2aError(A2A_ERRORS.UNSUPPORTED_OPERATION, 'Streaming is not supported. Use SendMessage instead.') });
        return;
      default:
        res.json({ jsonrpc: '2.0', id, error: a2aError(-32601, `Method not found: ${method}`) });
    }
  } catch (err: any) {
    res.json({ jsonrpc: '2.0', id, error: a2aError(-32603, err.message) });
  }
}

// ─── SendMessage ───

async function handleSendMessage(rpcId: any, params: any, res: Response) {
  const { message, configuration } = params || {};

  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(-32602, 'Invalid params: message with non-empty parts array required'),
    });
    return;
  }

  if (message.parts.length > 20) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(-32602, 'Too many message parts (max 20)'),
    });
    return;
  }

  // If taskId is provided, check if task exists and is not terminal
  if (message.taskId) {
    const existingTask = await getTask(message.taskId);
    if (!existingTask) {
      res.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: a2aError(A2A_ERRORS.TASK_NOT_FOUND, 'Task not found'),
      });
      return;
    }
    if (TERMINAL_STATES.has(existingTask.status.state)) {
      res.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: a2aError(A2A_ERRORS.UNSUPPORTED_OPERATION, 'Cannot send message to a task in terminal state. Create a new task using the same contextId.'),
      });
      return;
    }
  }

  // Extract user text from message parts
  const userText = message.parts
    .filter((p: any) => p.text !== undefined)
    .map((p: any) => typeof p.text === 'string' ? p.text : '')
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);

  if (!userText.trim()) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(-32602, 'No text content found in message parts'),
    });
    return;
  }

  const taskId = message.taskId || crypto.randomUUID();
  const contextId = message.contextId || crypto.randomUUID();
  const messageId = message.messageId || crypto.randomUUID();

  const now = new Date().toISOString();
  const existingTask = message.taskId ? await getTask(taskId) : null;
  const task: A2ATask = existingTask || {
    id: taskId,
    contextId,
    status: {
      state: 'TASK_STATE_SUBMITTED',
      timestamp: now,
    },
    history: [],
    artifacts: [],
  };

  // Add user message to history
  task.history.push({
    messageId,
    role: 'ROLE_USER',
    parts: message.parts,
  });

  // Transition to WORKING
  task.status = {
    state: 'TASK_STATE_WORKING',
    timestamp: new Date().toISOString(),
  };
  await saveTask(task);

  try {
    const result = await runToppaAgent(userText, { source: 'a2a' as any });

    const responseText = typeof result.response === 'string'
      ? result.response
      : JSON.stringify(result.response);

    const agentMessageId = crypto.randomUUID();

    // Add agent response to history
    task.history.push({
      messageId: agentMessageId,
      role: 'ROLE_AGENT',
      parts: [{ text: responseText, mediaType: 'text/plain' }],
    });

    // Add artifact (the deliverable)
    task.artifacts.push({
      artifactId: crypto.randomUUID(),
      name: 'response',
      parts: [{ text: responseText, mediaType: 'text/plain' }],
    });

    task.status = {
      state: 'TASK_STATE_COMPLETED',
      message: { role: 'ROLE_AGENT', parts: [{ text: responseText }] },
      timestamp: new Date().toISOString(),
    };

    await saveTask(task);
    res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
  } catch (err: any) {
    task.status = {
      state: 'TASK_STATE_FAILED',
      message: { role: 'ROLE_AGENT', parts: [{ text: `Error: ${err.message}` }] },
      timestamp: new Date().toISOString(),
    };

    task.history.push({
      messageId: crypto.randomUUID(),
      role: 'ROLE_AGENT',
      parts: [{ text: `Error: ${err.message}` }],
    });

    await saveTask(task);
    res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
  }
}

// ─── GetTask ───

async function handleGetTask(rpcId: any, params: any, res: Response) {
  const taskId = params?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    res.json({ jsonrpc: '2.0', id: rpcId, error: a2aError(-32602, 'taskId (string) required') });
    return;
  }

  const task = await getTask(taskId);
  if (!task) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(A2A_ERRORS.TASK_NOT_FOUND, 'Task not found'),
    });
    return;
  }

  res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
}

// ─── CancelTask ───

async function handleCancelTask(rpcId: any, params: any, res: Response) {
  const taskId = params?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    res.json({ jsonrpc: '2.0', id: rpcId, error: a2aError(-32602, 'taskId (string) required') });
    return;
  }

  const task = await getTask(taskId);
  if (!task) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(A2A_ERRORS.TASK_NOT_FOUND, 'Task not found'),
    });
    return;
  }

  // Per spec: cannot cancel a task in terminal state
  if (TERMINAL_STATES.has(task.status.state)) {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: a2aError(A2A_ERRORS.TASK_NOT_CANCELABLE, `Task is in terminal state: ${task.status.state}`),
    });
    return;
  }

  task.status = {
    state: 'TASK_STATE_CANCELED',
    timestamp: new Date().toISOString(),
  };

  await saveTask(task);
  res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
}
