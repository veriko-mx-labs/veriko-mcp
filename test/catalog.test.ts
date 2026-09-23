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
    const args = { fecha: '2026-09-19', monto: 100, claveRastreo: 'ABC-123' };

    await tool.invoke(client, args);
    await tool.invoke(client, { ...args });

    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
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
