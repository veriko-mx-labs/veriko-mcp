import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveIdempotencyKey } from '../src/idempotency.js';

describe('idempotency keys', () => {
  it('generates a fresh key per call, so repeating a call is a new attempt', () => {
    const keys = new Set(Array.from({ length: 50 }, () => resolveIdempotencyKey(undefined)));
    assert.equal(keys.size, 50);
    for (const key of keys) assert.match(key, /^veriko_mcp_[0-9a-f-]{36}$/);
  });

  it('generates keys that match the API pattern', () => {
    assert.match(resolveIdempotencyKey(undefined), /^[A-Za-z0-9_-]{1,255}$/);
  });

  it('uses the key the caller provides', () => {
    assert.equal(resolveIdempotencyKey('order_2026_09_19'), 'order_2026_09_19');
  });

  it('rejects a key outside the API pattern', () => {
    assert.throws(() => resolveIdempotencyKey('has space'), /idempotency_key/);
    assert.throws(() => resolveIdempotencyKey('a'.repeat(256)), /idempotency_key/);
    assert.throws(() => resolveIdempotencyKey(12), /idempotency_key/);
  });
});
