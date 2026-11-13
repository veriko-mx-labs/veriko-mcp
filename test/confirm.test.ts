import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createHttpApp, startHttpServer } from '../src/http.js';
import { createVerikoServer } from '../src/server.js';
import { ALL, clientFor, json, startFakeApi, TEST_KEY, type FakeApi } from './support.js';

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

let api: FakeApi;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  api = await startFakeApi();
  api.reply = (_request, response) => json(response, 200, { data: { id: 'x', attributes: {} } });
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  await api.close();
});

const WEBHOOK = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** A client that declares elicitation and answers the questions with `answer`. */
async function legacySession(answer: Answer | undefined, asked: string[]) {
  const server = createVerikoServer({ config: ALL, client: clientFor(api) });
  const client = new Client(
    { name: 'confirm-test', version: '1.0.0' },
    answer ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (answer) {
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push((request.params as { message: string }).message);
      return answer;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('confirmation before destructive tools', () => {
  it('asks, and runs the operation once the person confirms', async () => {
    const asked: string[] = [];
    const client = await legacySession({ action: 'accept', content: { confirm: true } }, asked);

    const result = await client.callTool({ name: 'veriko_delete_webhook', arguments: { webhook_id: WEBHOOK } });

    assert.equal(result.isError, undefined);
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', new RegExp(WEBHOOK));
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0]?.method, 'DELETE');
  });

  for (const [label, answer, reason] of [
    ['declines', { action: 'decline' }, 'declined'],
    ['dismisses the question', { action: 'cancel' }, 'cancelled'],
    ['accepts without checking the box', { action: 'accept', content: { confirm: false } }, 'not_confirmed'],
  ] as const) {
    it(`does not call the API when the person ${label}`, async () => {
      const client = await legacySession(answer, []);

      const result = await client.callTool({ name: 'veriko_delete_webhook', arguments: { webhook_id: WEBHOOK } });

      assert.equal(result.isError, undefined);
      assert.deepEqual(
        { executed: (result.structuredContent as { executed: boolean }).executed, reason: (result.structuredContent as { reason: string }).reason },
        { executed: false, reason },
      );
      assert.equal(api.seen.length, 0);
    });
  }

  it('behaves as before when the client does not declare elicitation', async () => {
    const client = await legacySession(undefined, []);

    const result = await client.callTool({ name: 'veriko_delete_webhook', arguments: { webhook_id: WEBHOOK } });

    assert.equal(result.isError, undefined);
    assert.equal(api.seen.length, 1);
  });

  it('does not ask before a read or a plain write', async () => {
    const asked: string[] = [];
    const client = await legacySession({ action: 'accept', content: { confirm: true } }, asked);

    await client.callTool({ name: 'veriko_list_webhooks', arguments: {} });
    await client.callTool({ name: 'veriko_send_webhook_test', arguments: { webhook_id: WEBHOOK } });

    assert.deepEqual(asked, []);
  });

  it('asks before each destructive operation', async () => {
    const asked: string[] = [];
    const client = await legacySession({ action: 'decline' }, asked);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['veriko_delete_validation', { validation_id: WEBHOOK }],
      ['veriko_delete_webhook', { webhook_id: WEBHOOK }],
      ['veriko_regenerate_webhook_secret', { webhook_id: WEBHOOK }],
      ['veriko_regenerate_webhook_secret', { webhook_id: WEBHOOK, immediate: true }],
      ['veriko_delete_beneficiary', { beneficiary_id: 12 }],
      ['veriko_delete_beneficiary_import_row', { import_id: 3, row_id: 4 }],
      ['veriko_commit_beneficiary_import', { import_id: 3 }],
      [
        'veriko_update_validation_retry_policy',
        { validation_id: WEBHOOK, retry_policy: { enabled: true, max_retries: 2 } },
      ],
      ['veriko_update_my_retry_policy', { retry_policy: { enabled: true, max_retries: 2 } }],
    ];

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, name);
      assert.equal((result.structuredContent as { executed?: boolean }).executed, false, name);
    }

    assert.equal(asked.length, calls.length);
    assert.equal(api.seen.length, 0);
    assert.match(asked[3] ?? '', /revoke the previous one at once/);
    assert.match(asked[2] ?? '', /24 hours/);
  });

  it('asks through the input-required flow on the 2026-07-28 revision', async () => {
    const app = createHttpApp({
      config: { apiKey: '', profiles: new Set(['all']), maxRisk: 'destructive' },
      clientFactory: () => clientFor(api),
    });
    const server = await startHttpServer(app, { port: 0, host: '127.0.0.1' });
    cleanups.push(async () => {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    const asked: string[] = [];

    for (const [answer, expectedCalls] of [
      [{ action: 'decline' } as Answer, 0],
      [{ action: 'accept', content: { confirm: true } } as Answer, 1],
    ] as const) {
      api.seen.length = 0;
      const client = new Client(
        { name: 'confirm-test', version: '1.0.0' },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        },
      );
      client.setRequestHandler('elicitation/create', async (request) => {
        asked.push((request.params as { message: string }).message);
        return answer;
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TEST_KEY}` } },
        }),
      );

      const result = await client.callTool({ name: 'veriko_delete_webhook', arguments: { webhook_id: WEBHOOK } });

      assert.equal(result.isError, undefined);
      assert.equal(api.seen.length, expectedCalls);
      await client.close();
    }
    assert.equal(asked.length, 2);
  });
});
