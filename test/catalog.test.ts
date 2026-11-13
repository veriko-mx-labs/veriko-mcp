import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import {
  NOT_EXPOSED_OPERATIONS,
  OPERATION_TOOLS,
  QUOTA_WARNING,
  TOOL_CATALOG,
  selectTools,
  toSdk,
  type ToolRuntime,
} from '../src/catalog.js';

function tool(operationId: string) {
  const found = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
  assert.ok(found, operationId);
  return found;
}

function invoker(client: unknown) {
  return (operationId: string, args: Record<string, unknown>, runtime?: ToolRuntime) =>
    tool(operationId).invoke(client as Veriko, args, runtime);
}

const direct = {
  send_date: '2026-09-19',
  amount: 100,
  tracking_key: 'ABC-123',
  beneficiary_account: '012180004412345678',
};

describe('MCP catalog', () => {
  it('announces 73 operation tools and 3 wait tools, with no duplicate names', () => {
    assert.equal(OPERATION_TOOLS.length, 73);
    assert.equal(TOOL_CATALOG.length, 76);
    assert.equal(new Set(TOOL_CATALOG.map((item) => item.operationId)).size, 76);
    assert.equal(new Set(TOOL_CATALOG.map((item) => item.name)).size, 76);
    assert.deepEqual(
      TOOL_CATALOG.filter((item) => item.helper).map((item) => item.name).sort(),
      ['veriko_wait_for_beneficiary_import', 'veriko_wait_for_cep_export', 'veriko_wait_for_validation'],
    );
  });

  it('exposes validateAccount and no purge tool at any profile or risk level', () => {
    assert.deepEqual([...NOT_EXPOSED_OPERATIONS], ['prepareValidationPurge', 'executeValidationPurge']);
    const announced = selectTools(new Set(['all']), 'destructive').map((item) => item.operationId);
    for (const operationId of NOT_EXPOSED_OPERATIONS) assert.equal(announced.includes(operationId), false);
    assert.equal(announced.includes('validateAccount'), true);
    assert.equal(TOOL_CATALOG.some((item) => /purge/i.test(item.name)), false);
  });

  it('declares the quota consumption in the description, not only in the metadata', () => {
    for (const item of TOOL_CATALOG) {
      assert.equal(
        item.description.includes(QUOTA_WARNING),
        item.cost === 'quota',
        `${item.name} announces the quota inconsistently with its cost`,
      );
    }
    assert.deepEqual(
      TOOL_CATALOG.filter((item) => item.cost === 'quota').map((item) => item.operationId).sort(),
      ['validateDirect', 'validateOcr'],
    );
  });

  it('puts every tool title and description in English', () => {
    for (const item of TOOL_CATALOG) {
      assert.doesNotMatch(`${item.title} ${item.description}`, /[áéíóúñ¿¡]/, item.name);
      assert.ok(item.description.length > 20, item.name);
    }
  });

  it('the core profile has the validation flow, the allowance check and account validation', () => {
    const core = selectTools(new Set(['core']), 'write').map((item) => item.name).sort();
    assert.deepEqual(core, [
      'veriko_download_cep',
      'veriko_get_usage_limits',
      'veriko_get_validation',
      'veriko_list_validations',
      'veriko_validate_account',
      'veriko_validate_direct',
      'veriko_validate_ocr',
      'veriko_wait_for_validation',
    ]);
  });

  it('all exposes 76 and the risk limit applies separately', () => {
    assert.equal(selectTools(new Set(['all']), 'destructive').length, 76);
    assert.ok(selectTools(new Set(['all']), 'read').every((item) => item.risk === 'read'));
    assert.ok(selectTools(new Set(['core']), 'write').every((item) => item.core));
  });

  it('annotations are consistent with each operation', () => {
    for (const item of TOOL_CATALOG) {
      if (item.risk === 'read') {
        assert.equal(item.idempotent, true, `${item.name} reads, so it is idempotent`);
        assert.equal(item.destructive, false, item.name);
      }
    }
    for (const id of ['deleteWebhook', 'deleteBeneficiary', 'deleteValidation', 'cancelBeneficiaryImport']) {
      assert.equal(tool(id).destructive, true, id);
      assert.equal(tool(id).idempotent, true, id);
    }
    for (const id of ['updateWebhook', 'updateBeneficiary', 'patchBeneficiaryImportRow', 'updateMyRetryPolicy', 'updateValidationRetryPolicy']) {
      assert.equal(tool(id).idempotent, true, id);
      assert.equal(tool(id).destructive, true, id);
    }
    assert.equal(tool('validateDirect').idempotent, false);
    assert.equal(tool('validateDirect').destructive, false);
    assert.equal(tool('commitBeneficiaryImport').risk, 'destructive');
    assert.equal(tool('commitBeneficiaryImport').destructive, false);
    assert.equal(tool('createFinanceCepExport').destructive, false);
    assert.equal(tool('banxicoPublicStatus').openWorld, true);
    assert.equal(tool('listWebhooks').openWorld, false);
  });
});

describe('adapters', () => {
  it('toSdk maps snake_case to camelCase and drops undefined and omitted keys', () => {
    assert.deepEqual(toSdk({ per_page: 5, client_ref: 'a', skipped: 1, none: undefined }, ['skipped']), {
      perPage: 5,
      clientRef: 'a',
    });
  });

  it('uses a fresh random idempotency key on each validation call', async () => {
    const keys: string[] = [];
    const invoke = invoker({
      validations: {
        validate: async (args: { idempotencyKey?: string }) => {
          keys.push(args.idempotencyKey ?? '');
          return { ok: true };
        },
      },
    });

    await invoke('validateDirect', direct);
    await invoke('validateDirect', { ...direct });

    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.match(keys[0] ?? '', /^veriko_mcp_/);
  });

  it('sends the key the caller provides and reports it in the runtime', async () => {
    const keys: string[] = [];
    const invoke = invoker({
      validations: {
        validate: async (args: { idempotencyKey?: string }) => {
          keys.push(args.idempotencyKey ?? '');
          return { ok: true };
        },
      },
    });
    const runtime: ToolRuntime = {};

    await invoke('validateDirect', { ...direct, idempotency_key: 'order-4812' }, runtime);
    await invoke('validateDirect', { ...direct, idempotency_key: 'order-4812' });

    assert.deepEqual(keys, ['order-4812', 'order-4812']);
    assert.equal(runtime.idempotencyKey, 'order-4812');
  });

  it('applies a retry policy set back to an earlier value: no stale replay', async () => {
    const keys: string[] = [];
    const invoke = invoker({
      account: {
        updateMyRetryPolicy: async (_policy: unknown, options: { idempotencyKey?: string }) => {
          keys.push(options.idempotencyKey ?? '');
          return {};
        },
      },
    });
    for (const max of [1, 2, 1]) await invoke('updateMyRetryPolicy', { retry_policy: { enabled: true, max_retries: max } });
    assert.equal(new Set(keys).size, 3);
  });

  it('forwards client_ref to the SDK in the validation and in the filters', async () => {
    const received: Record<string, unknown> = {};
    const record = (name: string) => async (args: unknown) => {
      received[name] = args;
      return { ok: true };
    };
    const invoke = invoker({
      validations: {
        validate: record('validate'),
        enqueue: record('enqueue'),
        validateOcr: record('validateOcr'),
        list: record('list'),
        stats: record('stats'),
        export: record('export'),
      },
    });
    const fields = { ...direct, client_ref: 'order-4812' };

    await invoke('validateDirect', fields);
    await invoke('validateDirect', { ...fields, async: true });
    await invoke('validateOcr', { image_url: 'https://example.com/a.png', client_ref: 'order-4812' });
    await invoke('listValidations', { client_ref: 'order-4812' });
    await invoke('validationStats', { client_ref: 'order-4812' });
    await invoke('exportValidations', { client_ref: 'order-4812' });

    for (const [name, args] of Object.entries(received)) {
      assert.equal((args as { clientRef?: string }).clientRef, 'order-4812', name);
    }
    assert.equal(Object.keys(received).length, 6);
  });

  it('maps with_deleted 0 and 1 to the SDK scope and omits it when absent', async () => {
    const received: unknown[] = [];
    const invoke = invoker({
      validations: {
        list: async (args: unknown) => {
          received.push(args);
          return {};
        },
      },
    });
    await invoke('listValidations', { with_deleted: 1 });
    await invoke('listValidations', { with_deleted: 0 });
    await invoke('listValidations', {});
    assert.deepEqual(received, [{ withDeleted: true }, { withDeleted: false }, {}]);
  });

  it('forwards candidate_accounts and recipient_is_bank in the four validation paths', async () => {
    const received: Record<string, Record<string, unknown>> = {};
    const record = (name: string) => async (args: Record<string, unknown>) => {
      received[name] = args;
      return { ok: true };
    };
    const invoke = invoker({
      validations: {
        validate: record('validate'),
        enqueue: record('enqueue'),
        validateOcr: record('validateOcr'),
        enqueueOcr: record('enqueueOcr'),
      },
    });
    const candidates = ['012180004412345678', '002010077777777771'];
    const fields = { send_date: '2026-09-19', amount: 100, tracking_key: 'ABC-123', candidate_accounts: candidates, recipient_is_bank: true };

    await invoke('validateDirect', fields);
    await invoke('validateDirect', { ...fields, async: true });
    await invoke('validateOcr', { image_url: 'https://example.com/a.png', candidate_accounts: candidates, recipient_is_bank: true });
    await invoke('validateOcr', { image_url: 'https://example.com/a.png', candidate_accounts: candidates, async: true });

    assert.equal(Object.keys(received).length, 4);
    for (const [name, args] of Object.entries(received)) {
      assert.deepEqual(args['candidateAccounts'], candidates, name);
      assert.equal('beneficiaryAccount' in args, false, name);
    }
    assert.equal(received['validate']?.['recipientIsBank'], true);
  });

  it('forwards retain_image to the SDK, also when false', async () => {
    const received: Record<string, unknown>[] = [];
    const invoke = invoker({
      validations: {
        validateOcr: async (args: Record<string, unknown>) => {
          received.push(args);
          return { ok: true };
        },
      },
    });

    await invoke('validateOcr', { image_url: 'https://example.com/a.png', retain_image: false });
    await invoke('validateOcr', { image_url: 'https://example.com/a.png' });

    assert.equal(received[0]?.['retainImage'], false);
    assert.equal('retainImage' in (received[1] ?? {}), false);
  });

  it('rechecking a payment calls recheck with the identifier and consumes no quota', async () => {
    const received: string[] = [];
    const invoke = invoker({
      validations: {
        recheck: async (validationId: string) => {
          received.push(validationId);
          return { changed: false };
        },
      },
    });

    const result = await invoke('recheckValidation', { validation_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });

    assert.deepEqual(received, ['f47ac10b-58cc-4372-a567-0e02b2c3d479']);
    assert.deepEqual(result, { changed: false });
    const recheck = tool('recheckValidation');
    assert.equal(recheck.name, 'veriko_recheck_validation');
    assert.equal(recheck.risk, 'write');
    assert.equal(recheck.cost, 'included');
    assert.equal(recheck.core, false);
  });

  it('forwards a null description when creating a webhook', async () => {
    const received: unknown[] = [];
    const invoke = invoker({
      webhooks: {
        create: async (args: unknown) => {
          received.push(args);
          return { ok: true };
        },
      },
    });

    await invoke('createWebhook', { url: 'https://example.com/hook', events: ['validation.completed'], description: null });

    assert.deepEqual(received, [{ url: 'https://example.com/hook', events: ['validation.completed'], description: null }]);
  });

  it('creating a beneficiary strips separators and returns what the SDK returns', async () => {
    const invoke = invoker({
      beneficiaries: {
        create: async (args: Record<string, unknown>) => ({
          id: '42',
          attributes: { account_number: args['accountNumber'], status: 'active' },
          reactivated: true,
        }),
      },
    });

    const result = await invoke('createBeneficiary', { account_number: '0121 8000-4412345678' });

    assert.deepEqual(result, {
      id: '42',
      attributes: { account_number: '012180004412345678', status: 'active' },
      reactivated: true,
    });
    assert.equal(tool('createBeneficiary').description.includes('reactivated'), true);
  });

  it('a conditional read answers not_modified on a 304', async () => {
    const { ApiError } = await import('@veriko-mx/sdk-runtime');
    const invoke = invoker({
      catalog: {
        banks: async () => {
          throw new ApiError('HTTP 304', { status: 304 });
        },
      },
    });

    assert.deepEqual(await invoke('listBanks', { if_none_match: 'W/"a"' }), {
      not_modified: true,
      etag: 'W/"a"',
    });
  });

  it('the SPEI calendar calls speiCalendar with the year', async () => {
    const received: unknown[] = [];
    const invoke = invoker({
      catalog: {
        speiCalendar: async (year: number, options: Record<string, unknown>) => {
          received.push(year, options);
          return { attributes: { year } };
        },
      },
    });

    const result = await invoke('getSpeiCalendar', { year: 2026, if_none_match: '"a1b2c3d4e5f6"' });

    assert.deepEqual(received, [2026, { ifNoneMatch: '"a1b2c3d4e5f6"' }]);
    assert.deepEqual(result, { attributes: { year: 2026 } });
  });

  it('forces preview in the four structured reports', () => {
    for (const operationId of ['getFinanceMonthly', 'getFinanceCounterparties', 'getFinanceByBank', 'getFinanceAccounting']) {
      assert.equal(tool(operationId).inputSchema.parse({ month: '2026-09' }).format, 'preview');
    }
  });

  it('validateAccount forwards the account and type', async () => {
    const received: unknown[] = [];
    const invoke = invoker({
      beneficiaries: {
        validateAccount: async (args: unknown) => {
          received.push(args);
          return { checksum_valid: true };
        },
      },
    });
    await invoke('validateAccount', { account: '012180004412345678', type: 'clabe' });
    assert.deepEqual(received, [{ account: '012180004412345678', type: 'clabe' }]);
  });
});
