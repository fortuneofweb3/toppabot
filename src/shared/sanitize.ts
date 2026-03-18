/**
 * Shared input sanitization functions.
 * Used by API server and MCP tools for consistent validation.
 */

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
