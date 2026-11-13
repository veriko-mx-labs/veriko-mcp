import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ALL, clientFor, connect, json, startFakeApi, type Connected, type FakeApi } from './support.js';

let api: FakeApi;
const open: Connected[] = [];

beforeEach(async () => {
  api = await startFakeApi();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  await api.close();
});

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

async function session() {
  const connected = await connect({ config: ALL, client: clientFor(api) });
  open.push(connected);
  return connected;
}

function validation(status: string) {
  return { data: { type: 'validation', id: ID, attributes: { status } } };
}

describe('progress and cancellation', () => {
  it('reports one progress notification per poll when the request has a progress token', async () => {
    const states = ['processing', 'valid'];
    api.reply = (_request, response) =>
      json(response, 200, validation(states.shift() ?? 'valid'), { 'Retry-After': '1' });
    const { client } = await session();
    const updates: Array<{ progress: number; message?: string | undefined }> = [];

    const result = await client.callTool(
      { name: 'veriko_wait_for_validation', arguments: { validation_id: ID, timeout_seconds: 10 } },
      { onprogress: (update) => updates.push(update) },
    );

    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { terminal: boolean }).terminal, true);
    assert.deepEqual(
      updates.map((update) => update.progress),
      [1, 2],
    );
    assert.match(updates[0]?.message ?? '', /processing/);
    assert.match(updates[1]?.message ?? '', /valid/);
  });

  it('sends no progress when the request has no progress token', async () => {
    api.reply = (_request, response) => json(response, 200, validation('valid'));
    const { client } = await session();
    const result = await client.callTool({ name: 'veriko_wait_for_validation', arguments: { validation_id: ID } });
    assert.equal(result.isError, undefined);
  });

  it('reports the start and the end of a download', async () => {
    api.reply = (_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/pdf');
      response.setHeader('content-disposition', 'attachment; filename="cep.pdf"');
      response.end(Buffer.from('%PDF-1.4 test'));
    };
    const { client } = await session();
    const updates: Array<{ progress: number; total?: number | undefined; message?: string | undefined }> = [];

    const result = await client.callTool(
      { name: 'veriko_download_cep', arguments: { validation_id: ID, format: 'pdf' } },
      { onprogress: (update) => updates.push(update) },
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(
      updates.map((update) => [update.progress, update.total]),
      [
        [0, 2],
        [1, 2],
      ],
    );
    assert.match(updates[1]?.message ?? '', /13 bytes/);
  });

  it('stops a wait and its in-flight API call when the client cancels', async () => {
    let reachedApi = 0;
    let closedByServer = 0;
    api.reply = (_request, response) => {
      reachedApi += 1;
      response.on('close', () => {
        closedByServer += 1;
      });
      // Never answers: the call stays in flight until it is aborted.
    };
    const { client } = await session();
    const controller = new AbortController();

    const pending = client.callTool(
      { name: 'veriko_wait_for_validation', arguments: { validation_id: ID, timeout_seconds: 40 } },
      { signal: controller.signal },
    );
    pending.catch(() => undefined);
    for (let waited = 0; reachedApi === 0 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reachedApi, 1);
    controller.abort();
    await assert.rejects(pending);

    for (let waited = 0; closedByServer === 0 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closedByServer, 1, 'the API connection was closed after the cancellation');
    assert.equal(reachedApi, 1, 'no further request was sent');
  });

  it('stops a long pause between polls when the client cancels', async () => {
    api.reply = (_request, response) => json(response, 200, validation('processing'), { 'Retry-After': '10' });
    const { client } = await session();
    const controller = new AbortController();
    const started = Date.now();

    const pending = client.callTool(
      { name: 'veriko_wait_for_validation', arguments: { validation_id: ID, timeout_seconds: 40 } },
      { signal: controller.signal },
    );
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await assert.rejects(pending);

    assert.ok(Date.now() - started < 3000);
    assert.equal(api.seen.length, 1);
  });
});
