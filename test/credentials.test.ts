import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { credentialsOnlyTo, isUnderBaseUrl } from '../src/client.js';

const BASE = 'https://api.example.com/v1';

/** Un fetch que sólo anota la URL y el Authorization con que se llamó. */
function recorder() {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), authorization: new Headers(init?.headers).get('authorization') });
    return new Response('{}');
  };
  return { seen, fetchImpl };
}

describe('isUnderBaseUrl', () => {
  it('reconoce sólo el origen y la ruta de la API', () => {
    assert.equal(isUnderBaseUrl('https://api.example.com/v1/validations', BASE), true);
    assert.equal(isUnderBaseUrl('https://api.example.com/v1', BASE), true);
    assert.equal(isUnderBaseUrl('https://api.example.com/v1x/validations', BASE), false);
    assert.equal(isUnderBaseUrl('https://api.example.com/otra', BASE), false);
    assert.equal(isUnderBaseUrl('https://api.example.com.evil.example/v1/validations', BASE), false);
    assert.equal(isUnderBaseUrl('http://api.example.com/v1/validations', BASE), false);
    assert.equal(isUnderBaseUrl('https://descargas.example.com/v1/cep.pdf', BASE), false);
    assert.equal(isUnderBaseUrl('https://api.example.com/cualquiera', 'https://api.example.com'), true);
  });
});

describe('credentialsOnlyTo', () => {
  it('pone el token OAuth sólo en peticiones a la API', async () => {
    const { seen, fetchImpl } = recorder();
    const guarded = credentialsOnlyTo(BASE, 'token-oauth', fetchImpl);
    await guarded(`${BASE}/validations`, { headers: { authorization: 'Bearer relleno' } });
    await guarded('https://descargas.example.com/cep.pdf', { headers: { authorization: 'Bearer relleno' } });
    assert.deepEqual(seen, [
      { url: `${BASE}/validations`, authorization: 'Bearer token-oauth' },
      { url: 'https://descargas.example.com/cep.pdf', authorization: null },
    ]);
  });

  it('quita la clave de API de una petición fuera de la API', async () => {
    const { seen, fetchImpl } = recorder();
    const guarded = credentialsOnlyTo(BASE, undefined, fetchImpl);
    const key = `Bearer veriko_${'a'.repeat(64)}`;
    await guarded(new URL(`${BASE}/usage/limits`), { headers: { authorization: key } });
    await guarded(new Request('https://otro.example/x', { headers: { authorization: key } }));
    assert.deepEqual(seen, [
      { url: `${BASE}/usage/limits`, authorization: key },
      { url: 'https://otro.example/x', authorization: null },
    ]);
  });
});
