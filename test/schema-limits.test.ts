import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { ToolDefinition } from '../src/catalog.js';
import { TOOL_CATALOG } from '../src/catalog.js';
import { createWebhookSchema } from '../src/schemas.js';
import {
  checkCatalogAgainstSpec,
  compareOperation,
  formatFindings,
  loadSpecDocument,
  specOperationFields,
  toolOperationFields,
} from '../scripts/schema-limits.js';

const specPath = fileURLToPath(new URL('../spec/openapi.yaml', import.meta.url));

function asTool(inputSchema: z.ZodType): ToolDefinition {
  return { inputSchema } as unknown as ToolDefinition;
}

describe('las restricciones del spec están reflejadas en los esquemas MCP', () => {
  it('ninguna de las 66 operaciones deja sin reflejar un límite del spec', () => {
    const document = loadSpecDocument(specPath);
    const findings = checkCatalogAgainstSpec(document, TOOL_CATALOG);
    assert.deepEqual(findings, [], `\n${formatFindings(findings)}`);
  });

  it('cada operación catalogada existe en el spec público', () => {
    const document = loadSpecDocument(specPath);
    for (const tool of TOOL_CATALOG) {
      assert.notEqual(
        specOperationFields(document, tool.operationId),
        null,
        `${tool.operationId} no aparece en el spec público`,
      );
    }
  });

  it('muerde cuando el esquema MCP deja de reflejar el maxLength de un campo del spec', () => {
    // Caso real: la descripción de un webhook. El spec público exige
    // maxLength 255; el esquema actual lo cubre con `.max(255)`.
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const withLimit = compareOperation('createWebhook', specFields, zodFields).filter(
      (finding) => finding.field === 'description',
    );
    assert.deepEqual(withLimit, [], 'con el .max(255) no debería haber hallazgos en description');

    // Simula exactamente la deriva que motivó este candado: el esquema
    // pierde el `.max(255)` (como si alguien lo quitara de schemas.ts).
    const weakened = new Map(zodFields);
    weakened.set('description', { ...zodFields.get('description')!, maxLength: undefined });

    const findings = compareOperation('createWebhook', specFields, weakened).filter(
      (finding) => finding.field === 'description',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.operationId, 'createWebhook');
    assert.equal(findings[0]?.kind, 'falta');
    assert.match(findings[0]?.detail ?? '', /maxLength 255/);
  });

  it('muerde cuando el esquema MCP no exige un campo que el spec exige', () => {
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const loosened = new Map(zodFields);
    loosened.set('url', { ...zodFields.get('url')!, required: false });

    const findings = compareOperation('createWebhook', specFields, loosened).filter(
      (finding) => finding.field === 'url',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'falta');
    assert.match(findings[0]?.detail ?? '', /el spec lo exige/);
  });

  it('muerde cuando el esquema MCP acepta un valor de enum que el spec no declara', () => {
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const widened = new Map(zodFields);
    const events = zodFields.get('events')!;
    widened.set('events', {
      ...events,
      items: events.items && { ...events.items, enum: [...(events.items.enum ?? []), 'evento.inventado'] },
    });

    const findings = compareOperation('createWebhook', specFields, widened).filter(
      (finding) => finding.field === 'events[]',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'sobra');
    assert.match(findings[0]?.detail ?? '', /evento\.inventado/);
  });

  it('no reporta un filtro opcional del spec que el catálogo decide no exponer', () => {
    // `listAllDeliveries` no expone el filtro `endpoint_id`: es una decisión
    // de catálogo, no una deriva del contrato (ver el comentario de alcance
    // al inicio de scripts/schema-limits.ts).
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'listAllDeliveries')!;
    assert.equal(specFields.get('endpoint_id')?.required, false);
  });
});
