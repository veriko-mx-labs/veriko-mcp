import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, it } from 'node:test';

import { CLOCK_LEEWAY_SECONDS, createAccessTokenVerifier } from '../src/access-token.js';

const ISSUER = 'https://api.example.com';
const RESOURCE = 'https://api.example.com/mcp';
const METADATA = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';
const AS_METADATA = 'https://api.example.com/.well-known/oauth-authorization-server';
const JWKS = 'https://api.example.com/v1/oauth/jwks';
const NOW = 1_800_000_000_000;

function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
}

const K1 = keyPair();
const K2 = keyPair();

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = K1.privateKey,
): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(NOW / 1000);
  const head = part({ alg: 'ES256', typ: 'at+jwt', kid: 'k1', ...header });
  const body = part({ iss: ISSUER, aud: RESOURCE, sub: '42', iat: seconds, nbf: seconds, exp: seconds + 3600, ...claims });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}

interface FakeServer {
  fetchImpl: typeof fetch;
  calls: string[];
  keys: Array<Record<string, unknown>>;
  down: boolean;
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    calls: [],
    keys: [{ ...K1.jwk, kid: 'k1', use: 'sig', alg: 'ES256' }],
    down: false,
    fetchImpl: async (input) => {
      const url = String(input);
      server.calls.push(url);
      if (server.down) throw new TypeError('fetch failed');
      const body =
        url === METADATA
          ? { resource: RESOURCE, authorization_servers: [ISSUER] }
          : url === AS_METADATA
            ? { issuer: ISSUER, jwks_uri: JWKS }
            : url === JWKS
              ? { keys: server.keys }
              : undefined;
      return body ? Response.json(body) : new Response('no', { status: 404 });
    },
  };
  return server;
}

function verifier(server: FakeServer, now: () => number = () => NOW) {
  return createAccessTokenVerifier({ resourceMetadataUrl: METADATA, fetchImpl: server.fetchImpl, now });
}

describe('createAccessTokenVerifier', () => {
  it('acepta un token firmado con la clave publicada, del emisor y para el recurso', async () => {
    const server = fakeServer();
    assert.deepEqual(await verifier(server).verify(token()), { ok: true });
    assert.deepEqual(server.calls, [METADATA, AS_METADATA, JWKS]);
  });

  it('guarda el descubrimiento y las claves entre peticiones', async () => {
    const server = fakeServer();
    const check = verifier(server);
    await check.verify(token());
    await check.verify(token());
    assert.equal(server.calls.length, 3);
  });

  it('rechaza una firma que no es de la clave del kid', async () => {
    const result = await verifier(fakeServer()).verify(token({}, {}, K2.privateKey));
    assert.deepEqual(result, { ok: false, kind: 'invalid', reason: 'signature' });
  });

  it('rechaza un token para otro recurso, aunque sea del mismo emisor', async () => {
    const check = verifier(fakeServer());
    assert.equal((await check.verify(token({ aud: 'https://api.example.com/v1' }))).ok, false);
    assert.equal((await check.verify(token({ aud: 'https://api.example.com/mcp/' }))).ok, false);
    assert.equal((await check.verify(token({ aud: ['https://otro.example', RESOURCE] }))).ok, true);
  });

  it('rechaza otro emisor', async () => {
    const result = await verifier(fakeServer()).verify(token({ iss: 'https://otro.example' }));
    assert.deepEqual(result, { ok: false, kind: 'invalid', reason: 'issuer' });
  });

  it('rechaza un token vencido o todavía no vigente, con la holgura de reloj', async () => {
    const seconds = Math.floor(NOW / 1000);
    const check = verifier(fakeServer());
    assert.equal((await check.verify(token({ exp: seconds - CLOCK_LEEWAY_SECONDS - 1 }))).ok, false);
    assert.equal((await check.verify(token({ exp: seconds - 10 }))).ok, true);
    assert.equal((await check.verify(token({ exp: undefined }))).ok, false);
    assert.equal((await check.verify(token({ nbf: seconds + CLOCK_LEEWAY_SECONDS + 5 }))).ok, false);
  });

  it('rechaza otra cabecera: alg, typ o sin kid', async () => {
    const check = verifier(fakeServer());
    assert.equal((await check.verify(token({}, { alg: 'none' }))).ok, false);
    assert.equal((await check.verify(token({}, { alg: 'HS256' }))).ok, false);
    assert.equal((await check.verify(token({}, { typ: 'JWT' }))).ok, false);
    assert.equal((await check.verify(token({}, { kid: undefined }))).ok, false);
    assert.equal((await check.verify('a.b')).ok, false);
  });

  it('vuelve a pedir el JWKS ante un kid nuevo, a lo más una vez por minuto', async () => {
    const server = fakeServer();
    let now = NOW;
    const check = verifier(server, () => now);
    await check.verify(token());
    server.keys.push({ ...K2.jwk, kid: 'k2', use: 'sig', alg: 'ES256' });

    // Recién pedido: no se repite la consulta y el kid nuevo todavía no se conoce.
    assert.deepEqual(await check.verify(token({}, { kid: 'k2' }, K2.privateKey)), { ok: false, kind: 'invalid', reason: 'unknown_key' });
    assert.equal(server.calls.filter((url) => url === JWKS).length, 1);

    now += 61_000;
    assert.deepEqual(await check.verify(token({}, { kid: 'k2' }, K2.privateKey)), { ok: true });
    assert.equal(server.calls.filter((url) => url === JWKS).length, 2);
  });

  it('distingue la falta de red (503) de un token malo (401)', async () => {
    const server = fakeServer();
    server.down = true;
    const result = await verifier(server).verify(token());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, 'unavailable');
  });

  it('no confía en metadatos de un emisor distinto del anunciado', async () => {
    const server = fakeServer();
    const inner = server.fetchImpl;
    server.fetchImpl = async (input, init) =>
      String(input) === AS_METADATA ? Response.json({ issuer: 'https://otro.example', jwks_uri: JWKS }) : inner(input, init);
    const result = await verifier(server).verify(token());
    assert.equal(!result.ok && result.kind, 'unavailable');
  });

  it('comparte la consulta en curso entre peticiones en paralelo', async () => {
    const server = fakeServer();
    let now = NOW;
    const check = verifier(server, () => now);
    await Promise.all(Array.from({ length: 20 }, () => check.verify(token())));
    assert.equal(server.calls.length, 3);

    now += 61_000;
    await Promise.all(Array.from({ length: 20 }, (_, i) => check.verify(token({}, { kid: `azar-${i}` }))));
    assert.equal(server.calls.filter((url) => url === JWKS).length, 2);
  });

  it('sigue con las claves que tenía si falla la renovación, y no reintenta enseguida', async () => {
    const server = fakeServer();
    let now = NOW;
    const check = verifier(server, () => now);
    await check.verify(token());
    server.down = true;
    now += 2 * 60 * 60 * 1000;
    const callsBefore = server.calls.length;
    assert.deepEqual(await check.verify(token({ iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 })), { ok: true });
    // Un intento a los metadatos y otro al JWKS; los dos fallan y se usa lo que había.
    assert.equal(server.calls.length - callsBefore, 2);
    await check.verify(token({}, { kid: 'otro' }));
    assert.equal(server.calls.length - callsBefore, 2);
  });

  it('sin claves previas, una caída da 503 y no se repite la consulta antes de 10 segundos', async () => {
    const server = fakeServer();
    server.down = true;
    const check = verifier(server);
    assert.equal(!(await check.verify(token())).ok, true);
    const result = await check.verify(token());
    assert.equal(!result.ok && result.kind, 'unavailable');
    assert.equal(server.calls.length, 1);
  });

  it('rechaza metadatos cuyo resource no es el de su URL', async () => {
    const server = fakeServer();
    const inner = server.fetchImpl;
    server.fetchImpl = async (input, init) =>
      String(input) === METADATA ? Response.json({ resource: 'https://api.example.com/v1', authorization_servers: [ISSUER] }) : inner(input, init);
    const result = await verifier(server).verify(token({ aud: 'https://api.example.com/v1' }));
    assert.equal(!result.ok && result.kind, 'unavailable');
  });

  it('descarta claves que no son EC P-256 públicas y firmas mal formadas', async () => {
    const server = fakeServer();
    server.keys = [{ ...K1.jwk, kid: 'k1', crv: 'P-384' }];
    assert.deepEqual(await verifier(server).verify(token()), { ok: false, kind: 'invalid', reason: 'unknown_key' });
    const good = token();
    const [head, body] = good.split('.');
    const check = verifier(fakeServer());
    assert.deepEqual(await check.verify(`${head}.${body}.`), { ok: false, kind: 'invalid', reason: 'signature' });
    assert.deepEqual(await check.verify(`${head}.${body}.${Buffer.alloc(63).toString('base64url')}`), { ok: false, kind: 'invalid', reason: 'signature' });
  });

  it('rechaza exp o nbf que no son números', async () => {
    const check = verifier(fakeServer());
    assert.equal((await check.verify(token({ exp: String(Math.floor(NOW / 1000) + 600) }))).ok, false);
    assert.equal((await check.verify(token({ nbf: null }))).ok, false);
  });
});
