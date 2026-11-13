import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Json } from '../scripts/schema-limits.js';
import {
  buildSummary,
  diffField,
  diffOperation,
  operationResponseCodes,
  operationSecurity,
  replaceExpectedSha,
  sha256,
} from '../scripts/sync-contract.js';

function documentWith(operations: Record<string, Json>): Json {
  return {
    info: { version: '1.0.0' },
    security: [{ ApiKeyAuth: [] }],
    paths: Object.fromEntries(
      Object.entries(operations).map(([operationId, operation]) => [
        `/${operationId}`,
        { get: { operationId, ...operation } },
      ]),
    ),
  };
}

describe('sha256 and the EXPECTED_PUBLIC_SPEC_SHA256', () => {
  it('produces the same SHA-256 the rest of the organization computes over the same text', () => {
    // Known vector: sha256("") = e3b0c4...
    assert.equal(
      sha256(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('replaces only the hexadecimal value, keeping the rest of the file', () => {
    const source = [
      "const EXPECTED_PUBLIC_SPEC_SHA256 =",
      "  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
      '',
      'otherLine();',
    ].join('\n');
    const updated = replaceExpectedSha(source, 'b'.repeat(64));
    assert.match(updated, /'b{64}';/);
    assert.match(updated, /otherLine\(\);/);
  });

  it('fails with a clear message when it cannot find the declaration', () => {
    assert.throws(() => replaceExpectedSha('without the constant', 'a'.repeat(64)), /EXPECTED_PUBLIC_SPEC_SHA256/);
  });
});

describe('diffField', () => {
  it('reports a new field', () => {
    const lines = diffField('foo', undefined, { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /new field `foo`/);
  });

  it('reports a removed field', () => {
    const lines = diffField('foo', { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false }, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /field removed `foo`/);
  });

  it('reports a maxLength that changed and stays silent about what did not', () => {
    const before = { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false, maxLength: 100 } as const;
    const after = { ...before, maxLength: 255 };
    const lines = diffField('description', before, after);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /maxLength 100 → 255/);

    assert.deepEqual(diffField('description', before, { ...before }), []);
  });
});

describe('buildSummary', () => {
  it('with no previous version, says so and does not try to diff', () => {
    const summary = buildSummary(undefined, documentWith({ foo: {} }));
    assert.match(summary, /There is no previous version/);
  });

  it('lists new and removed operations by location', () => {
    const previous = documentWith({ getFoo: {}, getBar: {} });
    const next = documentWith({ getFoo: {}, getBaz: {} });
    const summary = buildSummary(previous, next);
    assert.match(summary, /### New operations\n- `getBaz`/);
    assert.match(summary, /### Removed operations\n- `getBar`/);
  });

  it('describes a limit change in an operation that still exists', () => {
    const previous = documentWith({
      updateThing: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 100 } } },
            },
          },
        },
      },
    });
    const next = documentWith({
      updateThing: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 255 } } },
            },
          },
        },
      },
    });
    const summary = buildSummary(previous, next);
    assert.match(summary, /`note`: maxLength 100 → 255/);
  });
});

describe('diffOperation', () => {
  it('detects new responses and security', () => {
    const previous = documentWith({
      op: { responses: { '200': {} }, security: [{ ApiKeyAuth: [] }] },
    });
    const next = documentWith({
      op: { responses: { '200': {}, '429': {} }, security: [] },
    });
    const lines = diffOperation(previous, next, 'op');
    assert.ok(lines.some((line) => line.includes('new responses: 429')));
    assert.ok(lines.some((line) => line.includes('security:')));
  });

  it('with no changes, reports nothing', () => {
    const document = documentWith({ op: { responses: { '200': {} } } });
    assert.deepEqual(diffOperation(document, document, 'op'), []);
  });
});

describe('operationResponseCodes and operationSecurity', () => {
  it('read the responses and security declared by the operation', () => {
    const document = documentWith({
      op: { responses: { '200': {}, '404': {} }, security: [{ ApiKeyAuth: [] }] },
    });
    assert.deepEqual([...operationResponseCodes(document, 'op')].sort(), ['200', '404']);
    assert.deepEqual(operationSecurity(document, 'op'), [{ ApiKeyAuth: [] }]);
  });

  it('an operation with no security of its own inherits the global one', () => {
    const document = documentWith({ op: { responses: {} } });
    assert.deepEqual(operationSecurity(document, 'op'), [{ ApiKeyAuth: [] }]);
  });
});
