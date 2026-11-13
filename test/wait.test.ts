import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { TOOL_CATALOG, type ToolRuntime } from '../src/catalog.js';
import { CEP_EXPORT_TERMINAL_STATUSES, VALIDATION_TERMINAL_STATUSES } from '../src/schemas.js';
import { withCapture } from '../src/client.js';
import { clientFor, json, startFakeApi, type FakeApi } from './support.js';

let api: FakeApi;
beforeEach(async () => {
  api = await startFakeApi();
});
afterEach(async () => {
  await api.close();
});

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** A virtual clock: sleeping advances time, so the tests do not wait. */
function clock(): ToolRuntime & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      now += milliseconds;
    },
  };
}

async function run(operationId: string, args: Record<string, unknown>, runtime: ToolRuntime) {
  const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
  assert.ok(tool);
  return withCapture({ responses: 0 }, () => tool.invoke(clientFor(api), args, runtime));
}

function validation(status: string, extra: Record<string, unknown> = {}) {
  return { data: { type: 'validation', id: ID, attributes: { status, ...extra } } };
}

describe('wait tools', () => {
  it('polls until the validation is settled, honoring Retry-After and sending the ETag', async () => {
    const states = ['queued', 'processing', 'valid'];
    api.reply = (request, response) => {
      const status = states.shift() ?? 'valid';
      if (request.headers['if-none-match'] === 'W/"1-processing"' && status === 'processing') {
        response.statusCode = 304;
        response.end();
        return;
      }
      json(response, 200, validation(status), {
        ETag: `W/"1-${status}"`,
        ...(status === 'valid' ? {} : { 'Retry-After': '3' }),
      });
    };
    const runtime = clock();

    const result = (await run('waitForValidation', { validation_id: ID }, runtime)) as Record<string, unknown>;

    assert.equal(result.terminal, true);
    assert.equal(result.waiting, false);
    assert.equal(result.status, 'valid');
    assert.equal(result.polls, 3);
    assert.deepEqual(runtime.slept, [3000, 3000]);
    assert.equal(api.seen[1]?.headers['if-none-match'], 'W/"1-queued"');
  });

  it('paces the polls with the next_poll_after_seconds the API reports in the body', async () => {
    const states = ['processing', 'valid'];
    api.reply = (_request, response) =>
      json(response, 200, {
        ...validation(states.shift() ?? 'valid'),
        meta: { next_poll_after_seconds: 4 },
      });
    const runtime = clock();

    const result = (await run('waitForValidation', { validation_id: ID }, runtime)) as Record<string, unknown>;

    assert.equal(result.terminal, true);
    assert.deepEqual(runtime.slept, [4000]);
  });

  it('keeps waiting through a not_found while a retry cycle is alive', async () => {
    api.reply = (_request, response) =>
      json(response, 200, validation('not_found', { retry_state: { enabled: true, terminal_state: null } }));
    const runtime = clock();

    const result = (await run('waitForValidation', { validation_id: ID, timeout_seconds: 6 }, runtime)) as Record<string, unknown>;

    assert.equal(result.terminal, false);
    assert.equal(result.waiting, true);
    assert.equal(result.status, 'not_found');
  });

  it('stops at the time limit with waiting true and the next poll hint', async () => {
    api.reply = (_request, response) => json(response, 200, validation('processing'), { 'Retry-After': '2' });
    const runtime = clock();

    const result = (await run('waitForValidation', { validation_id: ID, timeout_seconds: 5 }, runtime)) as Record<string, unknown>;

    assert.equal(result.waiting, true);
    assert.equal(result.terminal, false);
    assert.equal(result.next_poll_after_seconds, 2);
    assert.ok((result.waited_seconds as number) <= 5);
    assert.ok(runtime.slept.every((milliseconds) => milliseconds === 2000));
  });

  it('bounds the pause between polls', async () => {
    api.reply = (_request, response) => json(response, 200, validation('processing'), { 'Retry-After': '600' });
    const runtime = clock();

    await run('waitForValidation', { validation_id: ID, timeout_seconds: 40 }, runtime);

    assert.ok(runtime.slept.every((milliseconds) => milliseconds <= 10_000));
  });

  it('waits for a CEP export until ready, failed or expired', async () => {
    const states = ['queued', 'building', 'ready'];
    api.reply = (_request, response) =>
      json(response, 200, { data: { type: 'cep_export', id: ID, attributes: { status: states.shift() ?? 'ready' } } });
    const runtime = clock();

    const result = (await run('waitForCepExport', { export_id: ID }, runtime)) as Record<string, unknown>;

    assert.equal(result.status, 'ready');
    assert.equal(result.terminal, true);
    assert.equal(result.polls, 3);
  });

  it('waits for a beneficiary import until preview_ready', async () => {
    const states = ['pending', 'parsing', 'preview_ready'];
    api.reply = (_request, response) =>
      json(response, 200, { data: { type: 'beneficiary_import', id: '7', attributes: { status: states.shift() ?? 'preview_ready' } } });
    const runtime = clock();

    const result = (await run('waitForBeneficiaryImport', { import_id: 7 }, runtime)) as Record<string, unknown>;

    assert.equal(result.status, 'preview_ready');
    assert.equal(result.terminal, true);
  });

  it('terminal states match the API x-terminal-values', () => {
    assert.deepEqual(
      [...VALIDATION_TERMINAL_STATUSES].sort(),
      ['cep_unavailable', 'error', 'failed', 'invalid', 'not_found', 'returned', 'valid'],
    );
  });

  it('every x-terminal-values list in the spec is one the server polls to', () => {
    const document = parse(readFileSync(new URL('../spec/openapi.yaml', import.meta.url), 'utf8')) as unknown;
    const lists: string[][] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'x-terminal-values' && Array.isArray(value)) lists.push(value.map(String));
        else walk(value);
      }
    };
    walk(document);
    const known = [[...VALIDATION_TERMINAL_STATUSES], [...CEP_EXPORT_TERMINAL_STATUSES]].map((list) => [...list].sort().join());
    for (const list of lists) {
      assert.ok(known.includes([...list].sort().join()), `unknown terminal set: ${list.join()}`);
    }
  });
});
