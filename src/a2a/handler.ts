import { Request, Response } from 'express';
import { runToppaAgent } from '../agent/graph';

/**
 * A2A (Agent-to-Agent Protocol) — JSON-RPC 2.0 Task Handler
 *
 * Follows the A2A spec v1.0: https://a2a-protocol.org
 *
 * Supports:
 * - SendMessage: Submit a natural-language task, routed through the LangGraph agent
 * - GetTask: Retrieve a task by ID
 * - CancelTask: Cancel a non-terminal task
 *
 * Error codes follow A2A spec:
 * - -32001: TaskNotFoundError
 * - -32002: TaskNotCancelableError
 * - -32004: UnsupportedOperationError
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
    state: string; // TASK_STATE_SUBMITTED | TASK_STATE_WORKING | TASK_STATE_COMPLETED | TASK_STATE_FAILED | TASK_STATE_CANCELED
    message?: { role: string; parts: Array<{ text?: string }> };
    timestamp: string;
  };
  history: Array<{ messageId: string; role: string; parts: Array<{ text?: string; mediaType?: string }> }>;
  artifacts: Array<{ artifactId: string; name?: string; parts: Array<{ text?: string; mediaType?: string }> }>;
  metadata?: Record<string, any>;
}

// ─── In-memory task store ───

const MAX_TASKS = 1000;
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TEXT_LENGTH = 10000;
const tasks = new Map<string, A2ATask>();

function pruneExpiredTasks() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (now - new Date(task.status.timestamp).getTime() > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
}

function evictOldestIfFull() {
  if (tasks.size >= MAX_TASKS) {
    pruneExpiredTasks();
  }
  if (tasks.size >= MAX_TASKS) {
    const oldestKey = tasks.keys().next().value;
    if (oldestKey) tasks.delete(oldestKey);
  }
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
      // A2A spec uses PascalCase method names in JSON-RPC binding
      case 'SendMessage':
      case 'message/send': // Also support legacy method name
        await handleSendMessage(id, params, res);
        return;
      case 'GetTask':
      case 'tasks/get':
        handleGetTask(id, params, res);
        return;
      case 'CancelTask':
      case 'tasks/cancel':
        handleCancelTask(id, params, res);
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
    const existingTask = tasks.get(message.taskId);
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

  evictOldestIfFull();

  const now = new Date().toISOString();
  const task: A2ATask = tasks.get(taskId) || {
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
  tasks.set(taskId, task);

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

    res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
  }
}

// ─── GetTask ───

function handleGetTask(rpcId: any, params: any, res: Response) {
  const taskId = params?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    res.json({ jsonrpc: '2.0', id: rpcId, error: a2aError(-32602, 'taskId (string) required') });
    return;
  }

  const task = tasks.get(taskId);
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

function handleCancelTask(rpcId: any, params: any, res: Response) {
  const taskId = params?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    res.json({ jsonrpc: '2.0', id: rpcId, error: a2aError(-32602, 'taskId (string) required') });
    return;
  }

  const task = tasks.get(taskId);
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

  res.json({ jsonrpc: '2.0', id: rpcId, result: { task } });
}
