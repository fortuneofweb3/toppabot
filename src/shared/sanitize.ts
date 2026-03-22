/**
 * Shared input sanitization functions.
 * Used by API server, MCP tools, A2A handler, and goal storage for consistent validation.
 */

// ─────────────────────────────────────────────────
// Prompt Injection Protection
// ─────────────────────────────────────────────────

/** Patterns that indicate prompt injection attempts. Shared across all input boundaries. */
export const INJECTION_PATTERNS = [
  'ignore previous', 'ignore all', 'new instructions', 'forget everything',
  'system:', 'admin:', 'sudo', 'root:', '<script>', '<|im_end|>', '<|im_start|>',
  'disregard', 'override', 'jailbreak', 'developer mode',
  '\\[system\\]', '\\{system\\}', '<\\|system\\|>', '<\\|user\\|>',
  'pretend you', 'act as if', 'roleplay as',
  'ignore above', 'ignore the above', 'ignore your instructions',
  'bypass', 'do anything now', 'respond with json',
  'important new instructions', 'maintenance mode',
];

/** Normalize text for injection detection — strips zero-width chars, homoglyphs. */
export function normalizeForInjectionCheck(input: string): string {
  return input
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .replace(/[\u0400-\u04FF]/g, (c) => {
      const map: Record<string, string> = { '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0455': 's', '\u0456': 'i', '\u0445': 'x' };
      return map[c] || c;
    });
}

/** Check if text contains injection patterns. Returns the matched pattern or null. */
export function detectInjection(input: string): string | null {
  const normalized = normalizeForInjectionCheck(input);
  for (const phrase of INJECTION_PATTERNS) {
    if (new RegExp(phrase, 'gi').test(normalized)) return phrase;
  }
  return null;
}

// ─────────────────────────────────────────────────
// Input Sanitization
// ─────────────────────────────────────────────────

export function sanitizeCountryCode(code: string | string[]): string {
  const input = Array.isArray(code) ? code[0] : code;
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid country code: must be a string');
  }
  const sanitized = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (sanitized.length < 2 || sanitized.length > 3) {
    throw new Error('Invalid country code: must be 2-3 letters (e.g. NG, KE, US)');
  }
  return sanitized;
}

export function sanitizeAccountNumber(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid account number: must be a non-empty string');
  }
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9\- ]+$/.test(trimmed)) {
    throw new Error('Invalid account number: contains invalid characters');
  }
  if (trimmed.length > 50) {
    throw new Error('Invalid account number: too long (max 50 characters)');
  }
  return trimmed;
}

export function sanitizePhone(phone: string): string {
  if (typeof phone !== 'string') {
    throw new Error('Invalid phone number: must be a string');
  }
  // Strip everything except digits and leading +
  const sanitized = phone.replace(/[^0-9+]/g, '');
  if (sanitized.length < 5 || sanitized.length > 20) {
    throw new Error('Invalid phone number: must be 5-20 characters');
  }
  // Allow at most one '+' and only at the start
  if (!/^\+?[0-9]+$/.test(sanitized)) {
    throw new Error('Invalid phone number: only digits allowed, with optional leading +');
  }
  return sanitized;
}
