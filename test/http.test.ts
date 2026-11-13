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
import { languageFrom } from '../src/request-overrides.js';
import { MCP_VERSION } from '../src/server.js';
import { json, startFakeApi } from './support.js';

const cleanups: Array<() => Promise<void>> = [];

/** Test keys with the real shape: `veriko_` and 64 hexadecimal characters. */
const KEY_A = `veriko_${'a'.repeat(64)}`;
const KEY_B = `veriko_${'b'.repeat(64)}`;
const KEY_C = `veriko_${'c'.repeat(64)}`;

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

/** Raw request with node:http, to set Host and Content-Length by hand. */
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
  it('extracts the key and rejects malformed formats', () => {
    assert.equal(bearerToken('Bearer veriko_abc'), 'veriko_abc');
    assert.equal(bearerToken('bearer   veriko_abc  '), 'veriko_abc');
    assert.equal(bearerToken(null), undefined);
    assert.equal(bearerToken('Basic abc'), undefined);
    assert.equal(bearerToken('Bearer a b'), undefined);
    assert.equal(bearerToken(`Bearer ${'x'.repeat(513)}`), undefined);
  });

  it('recognizes only the shape of a Veriko key', () => {
    assert.equal(isApiKeyShape(KEY_A), true);
    assert.equal(isApiKeyShape('veriko_abc'), false);
    assert.equal(isApiKeyShape(`veriko_${'A'.repeat(64)}`), false);
    assert.equal(isApiKeyShape(`otro_${'a'.repeat(64)}`), false);
    assert.equal(isApiKeyShape(`${KEY_A}0`), false);
  });
});

describe('stateless HTTP mode', () => {
  it('answers 401 without a key and does not open the endpoint', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer/);
  });

  it('serves /healthz unauthenticated and 404 on other paths', async () => {
    const base = await listen();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/otra`)).status, 404);
  });

  it('rejects a key of another shape before initialize', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer veriko_alice' },
      body: INITIALIZE,
    });
    assert.equal(response.status, 401);
  });

  it('accepts initialize with a well-formed key', async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` },
      body: INITIALIZE,
    });
    assert.equal(response.status, 200);
  });

  it('rejects any Origin when the origin list is empty', async () => {
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

  it('lets an Origin from the list through, compared as an origin', async () => {
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

  it('rejects a malformed origin at configuration', () => {
    assert.throws(() => createHttpApp({ allowedOrigins: ['app.veriko.mx'] }), /Invalid origin/);
  });

  it('rejects a Host outside the list (DNS rebinding)', async () => {
    const base = await listen();
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` };
    const rebind = await rawRequest(base, { ...headers, host: 'atacante.example:3000' }, INITIALIZE);
    assert.equal(rebind.status, 403);
    assert.deepEqual(JSON.parse(rebind.body), { error: 'host_not_allowed' });
    const local = await rawRequest(base, { ...headers, host: 'localhost:3000' }, INITIALIZE);
    assert.equal(local.status, 200);
  });

  it('accepts the configured hosts and nothing else', async () => {
    const base = await listen({ allowedHosts: ['mcp.ejemplo.com'] });
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}` };
    assert.equal((await rawRequest(base, { ...headers, host: 'MCP.ejemplo.com' }, INITIALIZE)).status, 200);
    assert.equal((await rawRequest(base, { ...headers, host: '127.0.0.1' }, INITIALIZE)).status, 403);
  });

  it('rejects a body declared larger than the cap without reading it', async () => {
    const base = await listen({ maxBodyBytes: 1024 });
    const result = await rawRequest(
      base,
      { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}`, 'content-length': String(2048) },
      'x'.repeat(2048),
    );
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body), { error: 'payload_too_large' });
  });

  it('cuts a body without Content-Length that passes the cap', async () => {
    const base = await listen({ maxBodyBytes: 1024 });
    const result = await rawRequest(
      base,
      { ...MCP_HEADERS, authorization: `Bearer ${KEY_A}`, 'transfer-encoding': 'chunked' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { relleno: 'x'.repeat(4096) } }),
    );
    assert.equal(result.status, 413);
  });

  it('rejects an Origin outside the list', async () => {
    const base = await listen({ allowedOrigins: ['https://app.veriko.mx'] });
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { origin: 'https://malo.example', authorization: 'Bearer k' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  });

  it('advertises tools and uses the key of each request, without mixing them', async () => {
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

  it('ignores VERIKO_API_KEY from the environment', async () => {
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

  it('delivers downloads embedded, with no resources in memory', async () => {
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
    assert.ok(name, 'the validations profile must advertise a download');

    const result = await client.callTool({
      name: name.name,
      arguments: { validation_id: '00000000-0000-4000-8000-000000000000', format: 'pdf' },
    });
    const block = (result.content as Array<{ type: string; resource?: { blob?: string; mimeType?: string } }>)[0];
    assert.equal(block?.type, 'resource');
    assert.equal(block?.resource?.mimeType, 'application/pdf');
    assert.equal(Buffer.from(block?.resource?.blob ?? '', 'base64').toString(), content.toString());

    // Stateless: no artifact store to read from, only the reference resources.
    const resources = await client.listResources().catch(() => ({ resources: [] }));
    assert.deepEqual(
      resources.resources.filter((resource) => resource.uri.startsWith('veriko://artifact/')),
      [],
    );
  });

  it('rejects with a clear error a file larger than the embedded cap', async () => {
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
    assert.match(error?.hint ?? '', /stdio package/);
  });

  it('suggests how to get a smaller export when it exceeds the embedded cap', async () => {
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
    assert.match(error?.hint ?? '', /Lower `limit` to export fewer rows, narrow `from` and `to`, add a `status` or `bank` filter; or download it with the local stdio package/);
  });
});

describe('veriko-mcp-http', () => {
  it('does not start outside 127.0.0.1 without VERIKO_MCP_ALLOWED_HOSTS', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, VERIKO_MCP_HTTP_HOST: '0.0.0.0', VERIKO_MCP_HTTP_PORT: '1' };
    delete env.VERIKO_MCP_ALLOWED_HOSTS;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/http-index.ts'], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VERIKO_MCP_ALLOWED_HOSTS is required/);
  });
});

describe('version', () => {
  it('matches package.json', async () => {
    const { default: manifest } = await import('../package.json', { with: { type: 'json' } });
    assert.equal(MCP_VERSION, manifest.version);
  });
});

describe('per-request overrides over HTTP', () => {
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

  it('narrows the risk of one request and refuses to widen it', async () => {
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

  it('narrows the profile of one request and refuses profiles the server does not announce', async () => {
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

  it('keeps the authentication, Host and Origin checks ahead of any override', async () => {
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

  it('sends the language of Accept-Language to the API and defaults to English', async () => {
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

  it('parses Accept-Language by weight and ignores languages the API does not answer in', () => {
    assert.equal(languageFrom('en;q=0.4, es;q=0.8'), 'es');
    assert.equal(languageFrom('fr, de'), undefined);
    assert.equal(languageFrom('es;q=0, en'), 'en');
    assert.equal(languageFrom(null), undefined);
  });
});
