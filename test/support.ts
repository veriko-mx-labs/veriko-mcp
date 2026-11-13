import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';

import { createClient } from '../src/client.js';
import { createVerikoServer, type CreateServerOptions } from '../src/server.js';

export const TEST_KEY = `veriko_${'0'.repeat(64)}`;

export interface SeenRequest {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage['headers'];
}

export type Reply = (request: SeenRequest, response: ServerResponse) => void;

export interface FakeApi {
  baseUrl: string;
  seen: SeenRequest[];
  reply: Reply;
  close(): Promise<void>;
}

/** A local HTTP server that stands in for the Veriko API. Set `reply` per test. */
export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    baseUrl: '',
    seen: [],
    reply: (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [], meta: {} }));
    },
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const seen: SeenRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        body,
        headers: request.headers,
      };
      api.seen.push(seen);
      api.reply(seen, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  api.baseUrl = `http://127.0.0.1:${port}/v1`;
  api.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}

export function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

/** An SDK client over the recording transport, aimed at the fake API. */
export function clientFor(api: FakeApi, overrides: { maxRetries?: number } = {}) {
  return createClient({
    apiKey: TEST_KEY,
    baseUrl: api.baseUrl,
    transportName: 'stdio',
    version: '0.0.0-test',
    maxRetries: overrides.maxRetries ?? 0,
  });
}

export interface Connected {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

export async function connect(options: CreateServerOptions): Promise<Connected> {
  const server = createVerikoServer(options);
  const client = new Client({ name: 'veriko-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const ALL = { apiKey: TEST_KEY, profiles: new Set(['all' as const]), maxRisk: 'destructive' as const };
