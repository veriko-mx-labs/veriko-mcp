import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stableIdempotencyKey } from '../src/idempotency.js';

describe('idempotencia estable', () => {
  it('produce la misma clave para objetos equivalentes', () => {
    const left = stableIdempotencyKey('validateDirect', {
      fecha: '2026-09-19',
      monto: 150,
      nested: { b: 2, a: 1 },
    });
    const right = stableIdempotencyKey('validateDirect', {
      nested: { a: 1, b: 2 },
      monto: 150,
      fecha: '2026-09-19',
    });

    assert.equal(left, right);
    assert.match(left, /^veriko_mcp_v1_[a-f0-9]{64}$/);
  });

  it('cambia cuando cambia un dato de negocio', () => {
    const left = stableIdempotencyKey('validateDirect', { fecha: '2026-09-19', monto: 150 });
    const right = stableIdempotencyKey('validateDirect', { fecha: '2026-09-19', monto: 151 });
    assert.notEqual(left, right);
  });

  it('resume binarios y no incorpora el base64 completo', () => {
    const image = Buffer.from('comprobante').toString('base64');
    const key = stableIdempotencyKey('validateOcr', { imageBase64: image });
    assert.match(key, /^veriko_mcp_v1_[a-f0-9]{64}$/);
    assert.ok(!key.includes(image));
  });

  it('respeta una clave explícita válida', () => {
    assert.equal(
      stableIdempotencyKey('validateDirect', { idempotencyKey: 'pedido_2026_09_19' }),
      'pedido_2026_09_19',
    );
  });
});
