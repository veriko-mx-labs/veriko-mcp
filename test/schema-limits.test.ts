import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { ToolDefinition } from '../src/catalog.js';
import { OPERATION_TOOLS } from '../src/catalog.js';
import { createWebhookSchema } from '../src/schemas.js';
import {
  checkCatalogAgainstSpec,
  compareOperation,
  formatFindings,
  loadSpecDocument,
  optionalFieldGaps,
  specOperationFields,
  toolOperationFields,
} from '../scripts/schema-limits.js';

const specPath = fileURLToPath(new URL('../spec/openapi.yaml', import.meta.url));

function asTool(inputSchema: z.ZodType): ToolDefinition {
  return { inputSchema } as unknown as ToolDefinition;
}

describe('las restricciones del spec se reflejan en los esquemas MCP', () => {
  it('ninguna operación del catálogo deja sin reflejar un límite del spec', () => {
    const document = loadSpecDocument(specPath);
    const findings = checkCatalogAgainstSpec(document, OPERATION_TOOLS);
    assert.deepEqual(findings, [], `\n${formatFindings(findings)}`);
  });

  it('toda operación del catálogo existe en el spec público', () => {
    const document = loadSpecDocument(specPath);
    for (const tool of OPERATION_TOOLS) {
      assert.notEqual(
        specOperationFields(document, tool.operationId),
        null,
        `${tool.operationId} no aparece en el spec público`,
      );
    }
  });

  it('detecta cuando el esquema MCP deja de reflejar el maxLength de un campo del spec', () => {
    // Caso real: la descripción de un webhook. El spec público exige
    // maxLength 255; el esquema actual lo cubre con `.max(255)`.
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const withLimit = compareOperation('createWebhook', specFields, zodFields).filter(
      (finding) => finding.field === 'description',
    );
    assert.deepEqual(withLimit, [], 'con .max(255) no debe haber hallazgos en description');

    // Simula la desviación para la que existe este candado: el esquema pierde su
    // `.max(255)` (como si alguien lo quitara de schemas.ts).
    const weakened = new Map(zodFields);
    weakened.set('description', { ...zodFields.get('description')!, maxLength: undefined });

    const findings = compareOperation('createWebhook', specFields, weakened).filter(
      (finding) => finding.field === 'description',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.operationId, 'createWebhook');
    assert.equal(findings[0]?.kind, 'missing');
    assert.match(findings[0]?.detail ?? '', /maxLength 255/);
  });

  it('detecta cuando el esquema MCP no exige un campo que el spec exige', () => {
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const loosened = new Map(zodFields);
    loosened.set('url', { ...zodFields.get('url')!, required: false });

    const findings = compareOperation('createWebhook', specFields, loosened).filter(
      (finding) => finding.field === 'url',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'missing');
    assert.match(findings[0]?.detail ?? '', /el spec lo exige/);
  });

  it('detecta cuando el esquema MCP acepta un valor de enum que el spec no declara', () => {
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const widened = new Map(zodFields);
    const events = zodFields.get('events')!;
    widened.set('events', {
      ...events,
      items: events.items && { ...events.items, enum: [...(events.items.enum ?? []), 'invented.event'] },
    });

    const findings = compareOperation('createWebhook', specFields, widened).filter(
      (finding) => finding.field === 'events[]',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'extra');
    assert.match(findings[0]?.detail ?? '', /invented\.event/);
  });

  it('no reporta un filtro opcional del spec que el catálogo decide no exponer', () => {
    // Un campo opcional que falta es una decisión del catálogo, no una desviación del contrato (ver
    // la nota de alcance al inicio de scripts/schema-limits.ts).
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'listAllDeliveries')!;
    assert.equal(specFields.get('endpoint_id')?.required, false);
  });

  it('lista los campos opcionales del spec que el MCP deja fuera, y sólo los aceptados', () => {
    // Cada entrada es una decisión deliberada: `user_id` es sólo de administradores y
    // no forma parte de la superficie del integrador; `image` se expone como `image_base64`.
    const document = loadSpecDocument(specPath);
    const gaps = optionalFieldGaps(document, OPERATION_TOOLS);
    const accepted = [
      'createFinanceCepExport.user_id',
      'getFinanceAccounting.user_id',
      'getFinanceByBank.user_id',
      'getFinanceCeps.user_id',
      'getFinanceCounterparties.user_id',
      'getFinanceMonthly.user_id',
      'getFinanceStatement.user_id',
      'getFinanceSummary.user_id',
      'validateOcr.image',
    ];
    assert.deepEqual(
      gaps.filter((gap) => !accepted.includes(gap)),
      [],
      'un campo opcional nuevo del spec no se expone: exponlo o acepta aquí la diferencia',
    );
  });
});
