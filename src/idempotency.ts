import { randomUUID } from 'node:crypto';

export const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * The key for one tool call.
 *
 * Without a caller key the call gets a fresh random key, so repeating the same
 * arguments is always a new attempt: a validation re-run after `not_found`
 * queries Banxico again, and a retry policy set back to an earlier value is
 * applied again. To make a retry safe after a lost response, the caller passes
 * the same `idempotency_key` it used the first time; the API then replays the
 * stored response for 24 hours and returns `Idempotent-Replayed: true`.
 */
export function resolveIdempotencyKey(provided: unknown): string {
  if (provided !== undefined) {
    if (typeof provided !== 'string' || !IDEMPOTENCY_PATTERN.test(provided)) {
      throw new TypeError('idempotency_key may use only A-Z, a-z, 0-9, _ and - (1 to 255 characters).');
    }
    return provided;
  }
  return `veriko_mcp_${randomUUID()}`;
}
