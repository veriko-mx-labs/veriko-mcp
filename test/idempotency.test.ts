import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveIdempotencyKey } from '../src/idempotency.js';

describe('idempotency keys', () => {
  it('genera una clave nueva por llamada, así que repetir una llamada es un intento nuevo', () => {
    const keys = new Set(Array.from({ length: 50 }, () => resolveIdempotencyKey(undefined)));
    assert.equal(keys.size, 50);
    for (const key of keys) assert.match(key, /^veriko_mcp_[0-9a-f-]{36}$/);
  });

  it('genera claves que cumplen el patrón de la API', () => {
    assert.match(resolveIdempotencyKey(undefined), /^[A-Za-z0-9_-]{1,255}$/);
  });

  it('usa la clave que da quien llama', () => {
    assert.equal(resolveIdempotencyKey('order_2026_09_19'), 'order_2026_09_19');
  });

  it('rechaza una clave fuera del patrón de la API', () => {
    assert.throws(() => resolveIdempotencyKey('has space'), /idempotency_key/);
    assert.throws(() => resolveIdempotencyKey('a'.repeat(256)), /idempotency_key/);
    assert.throws(() => resolveIdempotencyKey(12), /idempotency_key/);
  });
});
