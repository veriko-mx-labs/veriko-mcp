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

describe('catálogo MCP', () => {
  it('anuncia 73 herramientas de operación y 3 de espera, sin nombres repetidos', () => {
    assert.equal(OPERATION_TOOLS.length, 73);
    assert.equal(TOOL_CATALOG.length, 76);
    assert.equal(new Set(TOOL_CATALOG.map((item) => item.operationId)).size, 76);
    assert.equal(new Set(TOOL_CATALOG.map((item) => item.name)).size, 76);
    assert.deepEqual(
      TOOL_CATALOG.filter((item) => item.helper).map((item) => item.name).sort(),
      ['veriko_wait_for_beneficiary_import', 'veriko_wait_for_cep_export', 'veriko_wait_for_validation'],
    );
  });

  it('expone validateAccount y ninguna herramienta de purga en ningún perfil ni nivel de riesgo', () => {
    assert.deepEqual([...NOT_EXPOSED_OPERATIONS], ['prepareValidationPurge', 'executeValidationPurge']);
    const announced = selectTools(new Set(['all']), 'destructive').map((item) => item.operationId);
    for (const operationId of NOT_EXPOSED_OPERATIONS) assert.equal(announced.includes(operationId), false);
    assert.equal(announced.includes('validateAccount'), true);
    assert.equal(TOOL_CATALOG.some((item) => /purge/i.test(item.name)), false);
  });

  it('declara el consumo de cuota en la descripción, no sólo en los metadatos', () => {
    for (const item of TOOL_CATALOG) {
      assert.equal(
        item.description.includes(QUOTA_WARNING),
        item.cost === 'quota',
        `${item.name} anuncia la cuota de forma incoherente con su costo`,
      );
    }
    assert.deepEqual(
      TOOL_CATALOG.filter((item) => item.cost === 'quota').map((item) => item.operationId).sort(),
      ['validateDirect', 'validateOcr'],
    );
  });

  it('pone en español el título y la descripción de cada herramienta', () => {
    for (const item of TOOL_CATALOG) {
      assert.match(`${item.title} ${item.description}`, /\b(de|la|el|los|las|una|un|con|que|del|y)\b/, item.name);
      assert.ok(item.description.length > 20, item.name);
    }
  });

  it('el perfil core trae el flujo de validación, la consulta del saldo y la validación de cuentas', () => {
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

  it('all expone 76 y el límite de riesgo se aplica por separado', () => {
    assert.equal(selectTools(new Set(['all']), 'destructive').length, 76);
    assert.ok(selectTools(new Set(['all']), 'read').every((item) => item.risk === 'read'));
    assert.ok(selectTools(new Set(['core']), 'write').every((item) => item.core));
  });

  it('las anotaciones son coherentes con cada operación', () => {
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

describe('adaptadores', () => {
  it('toSdk pasa snake_case a camelCase y descarta las claves undefined y las omitidas', () => {
    assert.deepEqual(toSdk({ per_page: 5, client_ref: 'a', skipped: 1, none: undefined }, ['skipped']), {
      perPage: 5,
      clientRef: 'a',
    });
  });

  it('usa una clave de idempotencia aleatoria nueva en cada llamada de validación', async () => {
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

  it('envía la clave que da quien llama y la informa en el runtime', async () => {
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

  it('aplica una política de reintentos que vuelve a un valor anterior: sin repetir una respuesta vieja', async () => {
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

  it('reenvía client_ref al SDK en la validación y en los filtros', async () => {
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

  it('pasa with_deleted 0 y 1 al alcance del SDK y lo omite cuando falta', async () => {
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

  it('reenvía candidate_accounts y recipient_is_bank en los cuatro caminos de validación', async () => {
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

  it('reenvía retain_image al SDK, también cuando es false', async () => {
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

  it('revisar un pago llama a recheck con el identificador y no consume cuota', async () => {
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

  it('reenvía una descripción null al crear un webhook', async () => {
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

  it('crear un beneficiario quita los separadores y devuelve lo que devuelve el SDK', async () => {
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

  it('una lectura condicional responde not_modified con un 304', async () => {
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

  it('el calendario SPEI llama a speiCalendar con el año', async () => {
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

  it('obliga a preview en los cuatro reportes estructurados', () => {
    for (const operationId of ['getFinanceMonthly', 'getFinanceCounterparties', 'getFinanceByBank', 'getFinanceAccounting']) {
      assert.equal(tool(operationId).inputSchema.parse({ month: '2026-09' }).format, 'preview');
    }
  });

  it('validateAccount reenvía la cuenta y el tipo', async () => {
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
