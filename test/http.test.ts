import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Veriko } from '@veriko-mx/sdk-runtime';

import { bearerToken, createHttpApp, startHttpServer, type HttpOptions } from '../src/http.js';
import { MCP_VERSION } from '../src/server.js';

const cleanups: Array<() => Promise<void>> = [];

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
  it('extrae la clave y rechaza formatos inválidos', () => {
    assert.equal(bearerToken('Bearer veriko_abc'), 'veriko_abc');
    assert.equal(bearerToken('bearer   veriko_abc  '), 'veriko_abc');
    assert.equal(bearerToken(null), undefined);
    assert.equal(bearerToken('Basic abc'), undefined);
    assert.equal(bearerToken('Bearer a b'), undefined);
    assert.equal(bearerToken(`Bearer ${'x'.repeat(513)}`), undefined);
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

  it('expone /healthz sin autenticar y 404 en otras rutas', async () => {
    const base = await listen();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/otra`)).status, 404);
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

    const alice = await open(base, 'veriko_alice');
    const bob = await open(base, 'veriko_bob');

    const tools = await alice.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'veriko_list_public_plans'));

    const a = await alice.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    const b = await bob.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    assert.deepEqual(a.structuredContent, { data: [{ id: 'veriko_alice' }] });
    assert.deepEqual(b.structuredContent, { data: [{ id: 'veriko_bob' }] });
    assert.deepEqual(seen, ['veriko_alice', 'veriko_bob']);
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
    const client = await open(base, 'veriko_cliente');
    await client.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((key) => key === 'veriko_cliente'));
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
    const client = await open(base, 'veriko_k');
    const name = (await client.listTools()).tools.find((tool) => /download/.test(tool.name));
    assert.ok(name, 'el perfil validations debe anunciar una descarga');

    const result = await client.callTool({
      name: name.name,
      arguments: { validationId: '00000000-0000-4000-8000-000000000000', format: 'pdf' },
    });
    const block = (result.content as Array<{ type: string; resource?: { blob?: string; mimeType?: string } }>)[0];
    assert.equal(block?.type, 'resource');
    assert.equal(block?.resource?.mimeType, 'application/pdf');
    assert.equal(Buffer.from(block?.resource?.blob ?? '', 'base64').toString(), content.toString());

    // Sin estado: no hay plantilla de recursos que consultar.
    const resources = await client.listResources().catch(() => ({ resources: [] }));
    assert.deepEqual(resources.resources, []);
  });

  it('rechaza con un error claro un archivo mayor que el tope incrustado', async () => {
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
    const client = await open(base, 'veriko_k');
    const name = (await client.listTools()).tools.find((tool) => /download/.test(tool.name));
    const result = await client.callTool({
      name: name?.name ?? '',
      arguments: { validationId: '00000000-0000-4000-8000-000000000000', format: 'pdf' },
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error?: { code?: string } }).error?.code,
      'artifact_too_large',
    );
  });
});

describe('versión', () => {
  it('coincide con package.json', async () => {
    const { default: manifest } = await import('../package.json', { with: { type: 'json' } });
    assert.equal(MCP_VERSION, manifest.version);
  });
});
