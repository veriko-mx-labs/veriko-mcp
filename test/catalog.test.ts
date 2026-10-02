import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { AVISO_DE_CUOTA, TOOL_CATALOG, selectTools } from '../src/catalog.js';

describe('catálogo MCP', () => {
  it('cubre las 66 operaciones sin nombres duplicados', () => {
    assert.equal(TOOL_CATALOG.length, 66);
    assert.equal(new Set(TOOL_CATALOG.map((tool) => tool.operationId)).size, 66);
    assert.equal(new Set(TOOL_CATALOG.map((tool) => tool.name)).size, 66);
  });

  it('declara el consumo de cuota en la descripción, no sólo en los metadatos', () => {
    const conCuota = TOOL_CATALOG.filter((tool) => tool.cost === 'quota');
    assert.ok(conCuota.length > 0);

    for (const tool of TOOL_CATALOG) {
      // El modelo elige por la descripción; `_meta` no entra en esa decisión.
      assert.equal(
        tool.description.includes(AVISO_DE_CUOTA),
        tool.cost === 'quota',
        `${tool.name} anuncia la cuota de forma incoherente con su coste`,
      );
    }

    assert.deepEqual(
      conCuota.map((tool) => tool.operationId).sort(),
      ['validateDirect', 'validateOcr'],
    );
  });

  it('all expone 66 y el límite de riesgo se aplica aparte', () => {
    assert.equal(selectTools(new Set(['all']), 'destructive').length, 66);
    assert.ok(selectTools(new Set(['all']), 'read').every((tool) => tool.risk === 'read'));
    assert.ok(selectTools(new Set(['core']), 'write').every((tool) => tool.core));
  });

  it('genera idempotencia estable antes de llamar al SDK', async () => {
    const keys: string[] = [];
    const client = {
      validations: {
        validate: async (args: { idempotencyKey?: string }) => {
          keys.push(args.idempotencyKey ?? '');
          return { ok: true };
        },
      },
    } as unknown as Veriko;
    const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === 'validateDirect');
    assert.ok(tool);
    const args = {
      fecha: '2026-09-19',
      monto: 100,
      claveRastreo: 'ABC-123',
      cuentaBeneficiaria: '012180004412345678',
    };

    await tool.invoke(client, args);
    await tool.invoke(client, { ...args });

    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('reenvía clientRef al SDK en la validación y en los filtros', async () => {
    const received: Record<string, unknown> = {};
    const record = (name: string) => async (args: unknown) => {
      received[name] = args;
      return { ok: true };
    };
    const client = {
      validations: {
        validate: record('validate'),
        enqueue: record('enqueue'),
        validateOcr: record('validateOcr'),
        list: record('list'),
        stats: record('stats'),
        export: record('export'),
      },
    } as unknown as Veriko;
    const invoke = (operationId: string, args: Record<string, unknown>) => {
      const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
      assert.ok(tool, operationId);
      return tool.invoke(client, args);
    };
    const campos = {
      fecha: '2026-09-19',
      monto: 100,
      claveRastreo: 'ABC-123',
      cuentaBeneficiaria: '012180004412345678',
      clientRef: 'orden-4812',
    };

    await invoke('validateDirect', campos);
    await invoke('validateDirect', { ...campos, async: true });
    await invoke('validateOcr', { imageUrl: 'https://example.com/a.png', clientRef: 'orden-4812' });
    await invoke('listValidations', { clientRef: 'orden-4812' });
    await invoke('validationStats', { clientRef: 'orden-4812' });
    await invoke('exportValidations', { clientRef: 'orden-4812' });

    for (const [name, args] of Object.entries(received)) {
      assert.equal((args as { clientRef?: string }).clientRef, 'orden-4812', name);
    }
    assert.equal(Object.keys(received).length, 6);
  });

  it('cambia la clave de idempotencia cuando cambia clientRef', async () => {
    const keys: string[] = [];
    const client = {
      validations: {
        validate: async (args: { idempotencyKey?: string }) => {
          keys.push(args.idempotencyKey ?? '');
          return { ok: true };
        },
      },
    } as unknown as Veriko;
    const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === 'validateDirect');
    assert.ok(tool);
    const args = {
      fecha: '2026-09-19',
      monto: 100,
      claveRastreo: 'ABC-123',
      cuentaBeneficiaria: '012180004412345678',
    };

    await tool.invoke(client, { ...args, clientRef: 'orden-1' });
    await tool.invoke(client, { ...args, clientRef: 'orden-2' });

    assert.notEqual(keys[0], keys[1]);
  });

  it('reenvía description nula al crear un webhook', async () => {
    const received: unknown[] = [];
    const client = {
      webhooks: {
        create: async (args: unknown) => {
          received.push(args);
          return { ok: true };
        },
      },
    } as unknown as Veriko;
    const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === 'createWebhook');
    assert.ok(tool);

    await tool.invoke(client, {
      url: 'https://example.com/hook',
      events: ['validation.completed'],
      description: null,
    });

    assert.deepEqual(received, [
      {
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: null,
      },
    ]);
  });

  it('fuerza preview en los cuatro reportes estructurados', () => {
    for (const operationId of [
      'getFinanceMonthly',
      'getFinanceCounterparties',
      'getFinanceByBank',
      'getFinanceAccounting',
    ]) {
      const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
      assert.ok(tool);
      assert.equal(tool.inputSchema.parse({ month: '2026-09' }).format, 'preview');
    }
  });
});
