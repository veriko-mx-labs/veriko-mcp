import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { TOOL_CATALOG } from '../src/catalog.js';
import { clientFor, startFakeApi, type FakeApi, type SeenRequest } from './support.js';

let api: FakeApi;
let client: Veriko;

before(async () => {
  api = await startFakeApi();
  client = clientFor(api);
});

after(async () => {
  await api.close();
});

beforeEach(() => {
  api.seen.length = 0;
});

async function invoke(operationId: string, args: Record<string, unknown>): Promise<SeenRequest> {
  const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
  assert.ok(tool, operationId);
  await tool.invoke(client, args).catch(() => undefined);
  const request = api.seen[0];
  assert.ok(request, `${operationId} never reached the API`);
  return request;
}

const body = (request: SeenRequest) => JSON.parse(request.body) as Record<string, unknown>;
const search = (request: SeenRequest) => new URL(request.url, 'http://x').searchParams;

const direct = {
  send_date: '2026-09-19',
  amount: 100,
  tracking_key: 'ABC-123',
  beneficiary_account: '012180004412345678',
};

describe('what the SDK sends to the API: validations', () => {
  it('sends the English canonical names and no Spanish alias', async () => {
    const request = await invoke('validateDirect', {
      ...direct,
      numeric_reference: '1234567',
      sender_bank: '40012',
      receiver_bank: '40002',
      recipient_is_bank: true,
      client_ref: 'order-4812',
    });

    assert.equal(request.url, '/v1/validate');
    assert.deepEqual(body(request), {
      send_date: '2026-09-19',
      amount: 100,
      tracking_key: 'ABC-123',
      numeric_reference: '1234567',
      beneficiary_account: '012180004412345678',
      sender_bank: '40012',
      receiver_bank: '40002',
      recipient_is_bank: true,
      client_ref: 'order-4812',
    });
  });

  it('sends candidate_accounts without beneficiary_account, in both paths', async () => {
    const candidates = ['012180004412345678', '002010077777777771'];

    const sync = await invoke('validateDirect', {
      send_date: '2026-09-19',
      amount: 100,
      tracking_key: 'ABC-123',
      candidate_accounts: candidates,
    });
    assert.deepEqual(body(sync).candidate_accounts, candidates);
    assert.equal('beneficiary_account' in body(sync), false);

    api.seen.length = 0;
    const ocr = await invoke('validateOcr', {
      image_url: 'https://example.com/a.png',
      candidate_accounts: candidates,
      async: true,
    });
    assert.equal(ocr.url, '/v1/validate-ocr?async=1');
    assert.deepEqual(body(ocr).candidate_accounts, candidates);
  });

  it('sends the OCR fields with their English names, recipient_is_bank and retain_image', async () => {
    const request = await invoke('validateOcr', {
      image_url: 'https://example.com/a.png',
      sender_bank: '40012',
      receiver_bank: '40002',
      recipient_is_bank: true,
      retain_image: false,
    });

    assert.deepEqual(body(request), {
      image_url: 'https://example.com/a.png',
      sender_bank: '40012',
      receiver_bank: '40002',
      recipient_is_bank: true,
      retain_image: false,
    });
  });

  it('sends async=1 only when asked, with an Idempotency-Key header', async () => {
    const sync = await invoke('validateDirect', direct);
    assert.equal(sync.url, '/v1/validate');
    assert.match(String(sync.headers['idempotency-key']), /^veriko_mcp_/);
    api.seen.length = 0;
    const queued = await invoke('validateDirect', { ...direct, async: true });
    assert.equal(queued.url, '/v1/validate?async=1');
  });

  it('sends the retry policy with the API keys', async () => {
    const request = await invoke('validateDirect', {
      ...direct,
      retry_policy: { enabled: true, max_retries: 2, interval_seconds: 600, outcomes: ['not_found'] },
    });
    assert.deepEqual(body(request).retry_policy, {
      enabled: true,
      max_retries: 2,
      interval_seconds: 600,
      outcomes: ['not_found'],
    });
  });

  it('sends client_ref as the filter of the list, the statistics and the export', async () => {
    for (const [operationId, path] of [
      ['listValidations', '/v1/validations'],
      ['validationStats', '/v1/validations/stats'],
      ['exportValidations', '/v1/validations/export'],
    ] as const) {
      api.seen.length = 0;
      const request = await invoke(operationId, { client_ref: 'order 4812' });
      assert.equal(new URL(request.url, 'http://localhost').pathname, path);
      assert.equal(search(request).get('client_ref'), 'order 4812', operationId);
    }
  });

  it('sends no reference when there is no client_ref', async () => {
    assert.equal((await invoke('listValidations', {})).url.includes('client_ref'), false);
  });

  it('with_deleted keeps the API meaning: 0 active only, 1 withdrawn only, absent both', async () => {
    assert.equal(search(await invoke('listValidations', { with_deleted: 1 })).get('with_deleted'), '1');
    api.seen.length = 0;
    assert.equal(search(await invoke('listValidations', { with_deleted: 0 })).get('with_deleted'), '0');
    api.seen.length = 0;
    assert.equal(search(await invoke('listValidations', {})).has('with_deleted'), false);
  });

  it('with_archived keeps the API meaning on the list and the export', async () => {
    assert.equal(search(await invoke('listBeneficiaries', { with_archived: 1 })).get('with_archived'), '1');
    api.seen.length = 0;
    assert.equal(search(await invoke('exportBeneficiaries', { with_archived: 0 })).get('with_archived'), '0');
    api.seen.length = 0;
    assert.equal(search(await invoke('listBeneficiaries', {})).has('with_archived'), false);
  });

  it('sends per_page, status lists and banks separated by commas', async () => {
    const request = await invoke('listValidations', {
      per_page: 5,
      status: ['valid', 'returned'],
      banks: ['40012', '40014'],
      amount_min: 10,
    });
    const params = search(request);
    assert.equal(params.get('per_page'), '5');
    assert.equal(params.get('status'), 'valid,returned');
    assert.equal(params.get('banks'), '40012,40014');
    assert.equal(params.get('amount_min'), '10');
  });

  it('rechecking a payment is a POST to /recheck with no body', async () => {
    const request = await invoke('recheckValidation', { validation_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });

    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/validations/f47ac10b-58cc-4372-a567-0e02b2c3d479/recheck');
    assert.equal(request.body, '');
  });

  it('a retry policy PUT carries retry_policy and an Idempotency-Key', async () => {
    const request = await invoke('updateMyRetryPolicy', { retry_policy: { enabled: false } });
    assert.equal(request.method, 'PUT');
    assert.deepEqual(body(request), { retry_policy: { enabled: false } });
    assert.match(String(request.headers['idempotency-key']), /^veriko_mcp_/);
  });
});

describe('what the SDK sends to the API: catalog, accounts and deliveries', () => {
  it('the SPEI calendar is a GET with the year in the path', async () => {
    const request = await invoke('getSpeiCalendar', { year: 2026 });

    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v1/public/spei-calendar/2026');
  });

  it('validateAccount is a GET with account and type', async () => {
    const request = await invoke('validateAccount', { account: '0121800', type: 'clabe' });

    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url, 'http://x').pathname, '/v1/beneficiaries/validate-account');
    assert.equal(search(request).get('account'), '0121800');
    assert.equal(search(request).get('type'), 'clabe');
  });

  it('creating a beneficiary sends the digits and bank_code', async () => {
    const request = await invoke('createBeneficiary', { account_number: '5512 345678', bank_code: '40012', label: 'Ana' });

    assert.deepEqual(body(request), { account_number: '5512345678', bank_code: '40012', label: 'Ana' });
  });

  it('the delivery filters travel with the API names and format', async () => {
    const request = await invoke('listAllDeliveries', {
      endpoint_id: ['a1b2c3d4-e5f6-4789-abcd-ef0123456789', '7c9e6679-7425-40de-944b-e07fc1f90ae7'],
      status: ['failed', 'retrying'],
      response_status: ['5xx', 404],
      from: '2026-10-01',
      min_attempt: 2,
    });

    const url = new URL(request.url, 'http://x');
    assert.equal(url.pathname, '/v1/webhooks/deliveries');
    assert.equal(
      url.searchParams.get('endpoint_id'),
      'a1b2c3d4-e5f6-4789-abcd-ef0123456789,7c9e6679-7425-40de-944b-e07fc1f90ae7',
    );
    assert.equal(url.searchParams.get('status'), 'failed,retrying');
    assert.equal(url.searchParams.get('response_status'), '5xx,404');
    assert.equal(url.searchParams.get('from'), '2026-10-01');
    assert.equal(url.searchParams.get('min_attempt'), '2');
  });

  it('an endpoint with a filter exports from the global listing', async () => {
    const request = await invoke('exportWebhookDeliveries', {
      webhook_id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
      q: 'erp.example.com',
    });

    const url = new URL(request.url, 'http://x');
    assert.equal(url.pathname, '/v1/webhooks/deliveries/export');
    assert.equal(url.searchParams.get('endpoint_id'), 'a1b2c3d4-e5f6-4789-abcd-ef0123456789');
    assert.equal(url.searchParams.get('q'), 'erp.example.com');
  });

  it('a beneficiary import sends the file name and parse mode', async () => {
    const request = await invoke('createBeneficiaryImport', {
      file_base64: Buffer.from('a,b').toString('base64'),
      filename: 'beneficiaries.xlsx',
      parse_mode: 'free',
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/beneficiaries/imports');
    assert.match(request.body, /beneficiaries\.xlsx/);
    assert.match(request.body, /free/);
  });

  it('finance reports send month and format, and never user_id', async () => {
    const request = await invoke('getFinanceMonthly', { month: '2026-09', format: 'preview' });
    assert.equal(search(request).get('month'), '2026-09');
    assert.equal(search(request).has('user_id'), false);
  });

  it('a CEP export request sends the range and an Idempotency-Key', async () => {
    const request = await invoke('createFinanceCepExport', { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(body(request), { from: '2026-09-01', to: '2026-09-30' });
    assert.match(String(request.headers['idempotency-key']), /^veriko_mcp_/);
  });
});
