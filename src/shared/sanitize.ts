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

export function sanitizePhone(phone: string): string {
  if (typeof phone !== 'string') {
    throw new Error('Invalid phone number: must be a string');
  }
  const sanitized = phone.replace(/[^0-9+\-\s]/g, '');
  if (sanitized.length < 5 || sanitized.length > 20) {
    throw new Error('Invalid phone number: must be 5-20 digits');
  }
  return sanitized;
}
