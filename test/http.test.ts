import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Veriko } from '@veriko-mx/sdk-runtime';

import {
  bearerToken,
  createHttpApp,
  isApiKeyShape,
  startHttpServer,
  type HttpOptions,
} from '../src/http.js';
import { isAccessTokenShape } from '../src/client.js';
import { languageFrom } from '../src/request-overrides.js';
import { MCP_VERSION } from '../src/server.js';
import { json, startFakeApi } from './support.js';

const cleanups: Array<() => Promise<void>> = [];

/** Claves de prueba con la forma real: `veriko_` y 64 caracteres hexadecimales. */
const KEY_A = `veriko_${'a'.repeat(64)}`;
const KEY_B = `veriko_${'b'.repeat(64)}`;
const KEY_C = `veriko_${'c'.repeat(64)}`;

/** Un token de acceso con la forma real: JWT de tres partes con `typ: at+jwt` (RFC 9068). La firma no se revisa aquí. */
function accessToken(typ = 'at+jwt', scopes = 'validations.records.read'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', typ, kid: 'k1' })}.${part({ sub: '42', aud: 'https://api.example.com/mcp', scope: scopes })}.${'s'.repeat(86)}`;
}
const TOKEN = accessToken();
/** Acepta cualquier token: la verificación real se prueba en access-token.test.ts. */
const ACCEPT_ALL = { verify: async () => ({ ok: true }) as const };

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'prueba', version: '1.0.0' },
  },
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

/** Petición cruda con node:http, para fijar Host y Content-Length a mano. */
function rawRequest(
  base: string,
  headers: Record<string, string>,
  body = '',
): Promise<{ status: number; body: string }> {
  const url = new URL('/mcp', base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function listen(options: HttpOptions = {}): Promise<string> {
  const app = createHttpApp({
    config: { apiKey: '', profiles: new Set(['plans', 'validations']), maxRisk: 'read' },
    ...options,
  });
  const server = await startHttpServer(app, { port: 0, host: '127.0.0.1' });
  cleanups.push(async () => {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function open(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'veriko-http-test', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('bearerToken', () => {
  it('extrae la clave y rechaza los formatos mal formados', () => {
    assert.equal(bearerToken('Bearer veriko_abc'), 'veriko_abc');
    assert.equal(bearerToken('bearer   veriko_abc  '), 'veriko_abc');
    assert.equal(bearerToken(null), undefined);
    assert.equal(bearerToken('Basic abc'), undefined);
    assert.equal(bearerToken('Bearer a b'), undefined);
    assert.equal(bearerToken(`Bearer ${'x'.repeat(8193)}`), undefined);
  });

  it('reconoce sólo la forma de una clave de Veriko', () => {
    assert.equal(isApiKeyShape(KEY_A), true);
    assert.equal(isApiKeyShape('veriko_abc'), false);
    assert.equal(isApiKeyShape(`veriko_${'A'.repeat(64)}`), false);
    assert.equal(isApiKeyShape(`otro_${'a'.repeat(64)}`), false);
    assert.equal(isApiKeyShape(`${KEY_A}0`), false);
  });

  it('reconoce un token de acceso OAuth por su cabecera at+jwt', () => {
    assert.equal(isAccessTokenShape(TOKEN), true);
    assert.equal(isAccessTokenShape(accessToken('JWT')), false);
    assert.equal(isAccessTokenShape('a.b'), false);
    assert.equal(isAccessTokenShape('no.es.json'), false);
    assert.equal(isAccessTokenShape(`${TOKEN}.extra`), false);
    // Con el nivel Completo la lista de permisos pasa de 1 KB y el token sigue valiendo.
    const full = accessToken('at+jwt', 'validations.records.read '.repeat(60));
    assert.ok(full.length > 1024);
    assert.equal(isAccessTokenShape(full), true);
    assert.equal(bearerToken(`Bearer ${full}`), full);
  });
});

describe('modo HTTP sin estado', () => {
  it('responde 401 sin clave y no abre el endpoint', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer/);
  });

  it('anuncia los metadatos del recurso en el 401 cuando están configurados', async () => {
    const metadata = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';
    const base = await listen({ resourceMetadataUrl: metadata });
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get('www-authenticate'),
      `Bearer realm="veriko-mcp", resource_metadata="${metadata}"`,
    );
  });

  it('rechaza una URL de metadatos que no es https', () => {
    assert.throws(() => createHttpApp({ resourceMetadataUrl: 'http://api.example.com/x' }), /no válida/);
    assert.throws(() => createHttpApp({ resourceMetadataUrl: 'https://api.example.com/"x' }), /no válida/);
  });

  it('acepta initialize con un token de acceso OAuth', async () => {
    const base = await listen({ accessTokenVerifier: ACCEPT_ALL });
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: INITIALIZE,
    });
    assert.equal(response.status, 200);
  });

  it('rechaza un token OAuth que no pasa la verificación, sin leer el cuerpo', async () => {
    let checked = 0;
    const base = await listen({
      accessTokenVerifier: {
        verify: async () => {
          checked += 1;
          return { ok: false, kind: 'invalid', reason: 'audience' } as const;
        },
      },
      resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
      maxBodyBytes: 1024,
    });
    // Un cuerpo mayor que el tope: si se revisara después del tamaño, respondería 413.
    const response = await rawRequest(
      base,
      { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, 'content-length': String(2048) },
      'x'.repeat(2048),
    );
    assert.equal(response.status, 401);
    assert.match(response.body, /invalid_token/);
    assert.equal(checked, 1);
  });

  it('responde 503 si no puede obtener con qué verificar el token', async () => {
    const base = await listen({
      accessTokenVerifier: { verify: async () => ({ ok: false, kind: 'unavailable', reason: 'jwks' }) as const },
    });
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: INITIALIZE,
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
  });

  it('sin metadatos del recurso no acepta tokens OAuth, pero sí claves de API', async () => {
    const base = await listen();
    const oauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: INITIALIZE,
    });
    assert.equal(oauth.status, 401);
    assert.match(oauth.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    const key = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` },
      body: INITIALIZE,
    });
    assert.equal(key.status, 200);
  });

  it('sirve /healthz sin autenticación y 404 en las demás rutas', async () => {
    const base = await listen();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/otra`)).status, 404);
  });

  it('rechaza una clave de otra forma antes de initialize', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer veriko_alice' },
      body: INITIALIZE,
    });
    assert.equal(response.status, 401);
  });

  it('acepta initialize con una clave bien formada', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` },
      body: INITIALIZE,
    });
    assert.equal(response.status, 200);
  });

  it('rechaza cualquier Origin cuando la lista de orígenes está vacía', async () => {
    const base = await listen();
    for (const origin of ['https://malo.example', 'null', `http://127.0.0.1`]) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, origin, authorization: `Bearer ${KEY_A}` },
        body: INITIALIZE,
      });
      assert.equal(response.status, 403, origin);
      assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
    }
  });

  it('deja pasar un Origin de la lista, comparado como origen', async () => {
    const base = await listen({ allowedOrigins: ['https://App.Veriko.mx/'] });
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, origin: 'https://app.veriko.mx', authorization: `Bearer ${KEY_A}` },
      body: INITIALIZE,
    });
    assert.equal(response.status, 200);
    const other = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, origin: 'http://app.veriko.mx', authorization: `Bearer ${KEY_A}` },
      body: INITIALIZE,
    });
    assert.equal(other.status, 403);
  });

  it('rechaza un origen mal formado al configurar', () => {
    assert.throws(() => createHttpApp({ allowedOrigins: ['app.veriko.mx'] }), /Origen no válido/);
  });

  it('rechaza un Host fuera de la lista (DNS rebinding)', async () => {
    const base = await listen();
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` };
    const rebind = await rawRequest(base, { ...headers, host: 'atacante.example:3000' }, INITIALIZE);
    assert.equal(rebind.status, 403);
    assert.deepEqual(JSON.parse(rebind.body), { error: 'host_not_allowed' });
    const local = await rawRequest(base, { ...headers, host: 'localhost:3000' }, INITIALIZE);
    assert.equal(local.status, 200);
  });

  it('acepta los hosts configurados y nada más', async () => {
    const base = await listen({ allowedHosts: ['mcp.ejemplo.com'] });
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` };
    assert.equal((await rawRequest(base, { ...headers, host: 'MCP.ejemplo.com' }, INITIALIZE)).status, 200);
    assert.equal((await rawRequest(base, { ...headers, host: '127.0.0.1' }, INITIALIZE)).status, 403);
  });

  it('rechaza un cuerpo declarado mayor que el tope sin leerlo', async () => {
    const base = await listen({ maxBodyBytes: 1024 });
    const result = await rawRequest(
      base,
      { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}`, 'content-length': String(2048) },
      'x'.repeat(2048),
    );
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body), { error: 'payload_too_large' });
  });

  it('corta un cuerpo sin Content-Length que pasa el tope', async () => {
    const base = await listen({ maxBodyBytes: 1024 });
    const result = await rawRequest(
      base,
      { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}`, 'transfer-encoding': 'chunked' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { relleno: 'x'.repeat(4096) } }),
    );
    assert.equal(result.status, 413);
  });

  it('rechaza un Origin fuera de la lista', async () => {
    const base = await listen({ allowedOrigins: ['https://app.veriko.mx'] });
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { origin: 'https://malo.example', authorization: 'Bearer k' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  });

  it('anuncia herramientas y usa la clave de cada petición, sin mezclarlas', async () => {
    const seen: string[] = [];
    const base = await listen({
      clientFactory: (apiKey) =>
        ({
          plans: {
            listPublic: async () => {
              seen.push(apiKey);
              return { data: [{ id: apiKey }] };
            },
          },
        }) as unknown as Veriko,
    });

    const alice = await open(base, KEY_A);
    const bob = await open(base, KEY_B);

    const tools = await alice.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'veriko_list_public_plans'));

    const a = await alice.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    const b = await bob.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    assert.deepEqual(a.structuredContent, { data: [{ id: KEY_A }] });
    assert.deepEqual(b.structuredContent, { data: [{ id: KEY_B }] });
    assert.deepEqual(seen, [KEY_A, KEY_B]);
  });

  it('ignora VERIKO_API_KEY del entorno', async () => {
    const previous = process.env.VERIKO_API_KEY;
    process.env.VERIKO_API_KEY = 'veriko_del_servidor';
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.VERIKO_API_KEY;
      else process.env.VERIKO_API_KEY = previous;
    });
    const seen: string[] = [];
    const base = await listen({
      clientFactory: (apiKey) => {
        seen.push(apiKey);
        return {
          plans: { listPublic: async () => ({ data: [] }) },
        } as unknown as Veriko;
      },
    });
    const client = await open(base, KEY_C);
    await client.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((key) => key === KEY_C));
  });

  it('entrega las descargas incrustadas, sin recursos en memoria', async () => {
    const content = Buffer.from('%PDF-1.4 prueba');
    const base = await listen({
      clientFactory: () =>
        ({
          validations: {
            cep: async () => ({
              filename: 'cep.pdf',
              contentType: 'application/pdf',
              content,
            }),
          },
        }) as unknown as Veriko,
    });
    const client = await open(base, KEY_A);
    const name = (await client.listTools()).tools.find((tool) => /download/.test(tool.name));
    assert.ok(name, 'el perfil validations debe anunciar una descarga');

    const result = await client.callTool({
      name: name.name,
      arguments: { validation_id: '00000000-0000-4000-8000-000000000000', format: 'pdf' },
    });
    const block = (result.content as Array<{ type: string; resource?: { blob?: string; mimeType?: string } }>)[0];
    assert.equal(block?.type, 'resource');
    assert.equal(block?.resource?.mimeType, 'application/pdf');
    assert.equal(Buffer.from(block?.resource?.blob ?? '', 'base64').toString(), content.toString());

    // Sin estado: no hay almacén de artefactos que leer, sólo los recursos de referencia.
    const resources = await client.listResources().catch(() => ({ resources: [] }));
    assert.deepEqual(
      resources.resources.filter((resource) => resource.uri.startsWith('veriko://artifact/')),
      [],
    );
  });

  it('rechaza con un error claro un archivo mayor que el tope de incrustación', async () => {
    const base = await listen({
      maxInlineArtifactBytes: 4,
      clientFactory: () =>
        ({
          validations: {
            cep: async () => ({
              filename: 'cep.pdf',
              contentType: 'application/pdf',
              content: Buffer.from('12345678'),
            }),
          },
        }) as unknown as Veriko,
    });
    const client = await open(base, KEY_A);
    const name = (await client.listTools()).tools.find((tool) => /download/.test(tool.name));
    const result = await client.callTool({
      name: name?.name ?? '',
      arguments: { validation_id: '00000000-0000-4000-8000-000000000000', format: 'pdf' },
    });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error?: { code?: string; hint?: string; size?: number; limit?: number } }).error;
    assert.equal(error?.code, 'artifact_too_large');
    assert.equal(error?.size, 8);
    assert.equal(error?.limit, 4);
    assert.match(error?.hint ?? '', /paquete local por stdio/);
  });

  it('sugiere cómo obtener una exportación más pequeña cuando supera el tope de incrustación', async () => {
    const base = await listen({
      config: { apiKey: '', profiles: new Set(['validations']), maxRisk: 'read' },
      maxInlineArtifactBytes: 4,
      clientFactory: () =>
        ({
          validations: {
            export: async () => ({ filename: 'validations.csv', contentType: 'text/csv', content: Buffer.from('12345678') }),
          },
        }) as unknown as Veriko,
    });
    const client = await open(base, KEY_A);

    const result = await client.callTool({ name: 'veriko_export_validations', arguments: {} });

    const error = (result.structuredContent as { error?: { hint?: string } }).error;
    assert.match(error?.hint ?? '', /Baja `limit` para exportar menos filas, acota `from` y `to`, agrega un filtro `status` o `bank`; o descárgalo con el paquete local por stdio/);
  });
});

describe('veriko-mcp-http', () => {
  it('no arranca fuera de 127.0.0.1 sin VERIKO_MCP_ALLOWED_HOSTS', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, VERIKO_MCP_HTTP_HOST: '0.0.0.0', VERIKO_MCP_HTTP_PORT: '1' };
    delete env.VERIKO_MCP_ALLOWED_HOSTS;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/http-index.ts'], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VERIKO_MCP_ALLOWED_HOSTS es obligatorio/);
  });
});

describe('versión', () => {
  it('coincide con package.json', async () => {
    const { default: manifest } = await import('../package.json', { with: { type: 'json' } });
    assert.equal(MCP_VERSION, manifest.version);
  });
});

describe('ajustes por petición sobre HTTP', () => {
  const ALL_CONFIG = { apiKey: '', profiles: new Set(['all' as const]), maxRisk: 'destructive' as const };

  async function call(app: ReturnType<typeof createHttpApp>, method: string, params: unknown, headers: Record<string, string> = {}) {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${KEY_A}`,
          host: 'localhost',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    return { status: response.status, body: await response.text() };
  }

  function names(body: string): string[] {
    return [...body.matchAll(/"name":"(veriko_[a-z_]+)"/g)].map((match) => match[1] ?? '');
  }

  it('acota el riesgo de una petición y se niega a ampliarlo', async () => {
    const app = createHttpApp({ config: { ...ALL_CONFIG, maxRisk: 'write' } });
    cleanups.push(() => app.close());

    const all = names((await call(app, 'tools/list', {})).body);
    const reads = names((await call(app, 'tools/list', {}, { 'X-Veriko-Max-Risk': 'read' })).body);
    assert.ok(all.includes('veriko_validate_direct'));
    assert.equal(reads.includes('veriko_validate_direct'), false);
    assert.ok(reads.length > 0 && reads.length < all.length);

    const wider = await call(app, 'tools/list', {}, { 'X-Veriko-Max-Risk': 'destructive' });
    assert.equal(wider.status, 403);
    assert.match(wider.body, /max_risk_not_allowed/);
    assert.equal((await call(app, 'tools/list', {}, { 'X-Veriko-Max-Risk': 'root' })).status, 400);
  });

  it('acota el perfil de una petición y rechaza los perfiles que el servidor no anuncia', async () => {
    const all = createHttpApp({ config: ALL_CONFIG });
    const some = createHttpApp({ config: { ...ALL_CONFIG, profiles: new Set(['plans', 'webhooks']) } });
    cleanups.push(() => all.close(), () => some.close());

    assert.deepEqual(
      names((await call(all, 'tools/list', {}, { 'X-Veriko-Profile': 'plans' })).body).sort(),
      ['veriko_get_public_plan_comparison', 'veriko_list_public_plans'],
    );
    assert.ok(names((await call(some, 'tools/list', {}, { 'X-Veriko-Profile': 'plans' })).body).length === 2);
    const denied = await call(some, 'tools/list', {}, { 'X-Veriko-Profile': 'plans,finance' });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /profile_not_allowed/);
    assert.equal((await call(all, 'tools/list', {}, { 'X-Veriko-Profile': 'nonexistent' })).status, 400);
  });

  it('mantiene las comprobaciones de autenticación, Host y Origin antes de cualquier ajuste', async () => {
    const app = createHttpApp({ config: ALL_CONFIG });
    cleanups.push(() => app.close());

    const unauthenticated = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost', 'x-veriko-max-risk': 'read' },
        body: '{}',
      }),
    );
    assert.equal(unauthenticated.status, 401);

    const badHost = await call(app, 'tools/list', {}, { host: 'evil.example', 'X-Veriko-Max-Risk': 'read' });
    assert.equal(badHost.status, 403);
    assert.match(badHost.body, /host_not_allowed/);

    const badOrigin = await call(app, 'tools/list', {}, { origin: 'https://evil.example', 'X-Veriko-Max-Risk': 'read' });
    assert.equal(badOrigin.status, 403);
    assert.match(badOrigin.body, /origin_not_allowed/);
  });

  it('envía a la API el idioma de Accept-Language y usa inglés por omisión', async () => {
    const api = await startFakeApi();
    cleanups.push(() => api.close());
    api.reply = (_request, response) => json(response, 200, { data: [] });
    const app = createHttpApp({ config: { ...ALL_CONFIG, baseUrl: api.baseUrl } });
    cleanups.push(() => app.close());
    const params = { name: 'veriko_list_webhooks', arguments: {} };

    await call(app, 'tools/call', params, { 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.5' });
    await call(app, 'tools/call', params, { 'Accept-Language': 'fr-FR' });
    await call(app, 'tools/call', params);

    assert.deepEqual(
      api.seen.map((request) => request.headers['accept-language']),
      ['es', 'en', 'en'],
    );
  });

  it('manda a la API el token OAuth tal cual y nunca la clave de relleno del SDK', async () => {
    const api = await startFakeApi();
    cleanups.push(() => api.close());
    api.reply = (_request, response) => json(response, 200, { data: [] });
    const app = createHttpApp({ config: { ...ALL_CONFIG, baseUrl: api.baseUrl }, accessTokenVerifier: ACCEPT_ALL });
    cleanups.push(() => app.close());
    const params = { name: 'veriko_list_webhooks', arguments: {} };

    await call(app, 'tools/call', params, { authorization: `Bearer ${TOKEN}` });
    await call(app, 'tools/call', params);

    assert.deepEqual(
      api.seen.map((request) => request.headers.authorization),
      [`Bearer ${TOKEN}`, `Bearer ${KEY_A}`],
    );
  });

  it('interpreta Accept-Language por peso e ignora los idiomas en los que la API no responde', () => {
    assert.equal(languageFrom('en;q=0.4, es;q=0.8'), 'es');
    assert.equal(languageFrom('fr, de'), undefined);
    assert.equal(languageFrom('es;q=0, en'), 'en');
    assert.equal(languageFrom(null), undefined);
  });
});
