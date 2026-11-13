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

describe('the spec constraints are reflected in the MCP schemas', () => {
  it('no catalog operation leaves a spec limit unreflected', () => {
    const document = loadSpecDocument(specPath);
    const findings = checkCatalogAgainstSpec(document, OPERATION_TOOLS);
    assert.deepEqual(findings, [], `\n${formatFindings(findings)}`);
  });

  it('every cataloged operation exists in the public spec', () => {
    const document = loadSpecDocument(specPath);
    for (const tool of OPERATION_TOOLS) {
      assert.notEqual(
        specOperationFields(document, tool.operationId),
        null,
        `${tool.operationId} does not appear in the public spec`,
      );
    }
  });

  it('bites when the MCP schema stops reflecting the maxLength of a spec field', () => {
    // Real case: the description of a webhook. The public spec requires
    // maxLength 255; the current schema covers it with `.max(255)`.
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'createWebhook')!;
    const zodFields = toolOperationFields(asTool(createWebhookSchema));

    const withLimit = compareOperation('createWebhook', specFields, zodFields).filter(
      (finding) => finding.field === 'description',
    );
    assert.deepEqual(withLimit, [], 'with .max(255) there should be no findings on description');

    // Simulates the drift this lock exists for: the schema loses its
    // `.max(255)` (as if someone removed it from schemas.ts).
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

  it('bites when the MCP schema does not require a field the spec requires', () => {
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
    assert.match(findings[0]?.detail ?? '', /the spec requires it/);
  });

  it('bites when the MCP schema accepts an enum value the spec does not declare', () => {
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

  it('does not report an optional spec filter the catalog decides not to expose', () => {
    // A missing optional field is a catalog decision, not contract drift (see
    // the scope note at the top of scripts/schema-limits.ts).
    const document = loadSpecDocument(specPath);
    const specFields = specOperationFields(document, 'listAllDeliveries')!;
    assert.equal(specFields.get('endpoint_id')?.required, false);
  });

  it('lists the optional spec fields the MCP leaves out, and only the accepted ones', () => {
    // Each entry is a deliberate decision: `user_id` is administrator-only and
    // not part of the integrator surface; `image` is exposed as `image_base64`.
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
      'a new optional field of the spec is not exposed: expose it or accept the gap here',
    );
  });
});
