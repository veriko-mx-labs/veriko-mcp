import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { WEBHOOK_EVENTS } from '@veriko-mx/sdk-runtime';

import { bankCompleter, completeYear, startingWith } from '../src/completions.js';
import { ALL, clientFor, connect, json, startFakeApi, type Connected, type FakeApi } from './support.js';

let api: FakeApi;
const open: Connected[] = [];

const BANKS = {
  data: [
    { type: 'bank', id: '40012', attributes: { code: '40012', name: 'BBVA MEXICO', aliases: ['bancomer', 'bbva bancomer'] } },
    { type: 'bank', id: '40014', attributes: { code: '40014', name: 'SANTANDER', aliases: [] } },
    { type: 'bank', id: '40002', attributes: { code: '40002', name: 'BANAMEX', aliases: ['citibanamex'] } },
  ],
};

beforeEach(async () => {
  api = await startFakeApi();
  api.reply = (request, response) => {
    if (request.url.includes('/public/banks')) return json(response, 200, BANKS);
    return json(response, 200, { data: [] });
  };
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  await api.close();
});

async function session() {
  const connected = await connect({ config: ALL, client: clientFor(api) });
  open.push(connected);
  return connected.client;
}

describe('argument completion', () => {
  it('completes prompt arguments from the spec enums', async () => {
    const client = await session();

    const status = await client.complete({
      ref: { type: 'ref/prompt', name: 'triage_failed_validations' },
      argument: { name: 'status', value: 'c' },
    });
    assert.deepEqual(status.completion.values, ['cep_unavailable']);

    const events = await client.complete({
      ref: { type: 'ref/prompt', name: 'set_up_webhook' },
      argument: { name: 'event', value: 'validation.retry' },
    });
    assert.deepEqual(events.completion.values, [
      'validation.retry.scheduled',
      'validation.retry.resolved',
      'validation.retry.exhausted',
    ]);

    const formats = await client.complete({
      ref: { type: 'ref/prompt', name: 'export_validations' },
      argument: { name: 'format', value: '' },
    });
    assert.deepEqual(formats.completion.values, ['csv', 'xlsx']);
  });

  it('completes bank codes from the bank catalog, by code or by name', async () => {
    const client = await session();

    const byCode = await client.complete({
      ref: { type: 'ref/prompt', name: 'check_transfer' },
      argument: { name: 'beneficiary_bank', value: '4001' },
    });
    assert.deepEqual(byCode.completion.values, ['40012', '40014']);

    const byName = await client.complete({
      ref: { type: 'ref/prompt', name: 'export_validations' },
      argument: { name: 'bank', value: 'BANA' },
    });
    assert.deepEqual(byName.completion.values, ['40002']);

    const byAlias = await client.complete({
      ref: { type: 'ref/prompt', name: 'export_validations' },
      argument: { name: 'bank', value: 'bancomer' },
    });
    assert.deepEqual(byAlias.completion.values, ['40012']);

    const template = await client.complete({
      ref: { type: 'ref/resource', uri: 'veriko://catalog/banks/{code}' },
      argument: { name: 'code', value: 'santa' },
    });
    assert.deepEqual(template.completion.values, ['40014']);
  });

  it('completes the year of the SPEI calendar', async () => {
    const client = await session();
    const year = new Date().getUTCFullYear();

    const result = await client.complete({
      ref: { type: 'ref/resource', uri: 'veriko://catalog/spei-calendar/{year}' },
      argument: { name: 'year', value: String(year) },
    });

    assert.deepEqual(result.completion.values, [String(year)]);
  });

  it('reads one bank by code', async () => {
    const client = await session();

    const read = await client.readResource({ uri: 'veriko://catalog/banks/40014' });

    const text = (read.contents[0] as { text: string }).text;
    assert.equal(JSON.parse(text).attributes.name, 'SANTANDER');
    await assert.rejects(client.readResource({ uri: 'veriko://catalog/banks/99999' }));
  });

  it('reads the bank catalog once for several completions and gives no suggestions when it fails', async () => {
    const complete = bankCompleter(clientFor(api));
    await complete('4');
    await complete('40');
    assert.equal(api.seen.filter((request) => request.url.includes('/public/banks')).length, 1);

    api.reply = (_request, response) => json(response, 500, { errors: [{ code: 'server_error' }] });
    assert.deepEqual(await bankCompleter(clientFor(api))('4'), []);
  });

  it('keeps the helpers within the protocol limit and case-insensitive', () => {
    assert.deepEqual(startingWith(['Alpha', 'beta'], 'AL'), ['Alpha']);
    assert.equal(startingWith(WEBHOOK_EVENTS, '').length, WEBHOOK_EVENTS.length);
    assert.deepEqual(completeYear('2', new Date('2026-06-01T00:00:00Z')), ['2025', '2026', '2027']);
  });
});
