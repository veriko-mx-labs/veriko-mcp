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

describe('sha256 y la marca EXPECTED_PUBLIC_SPEC_SHA256', () => {
  it('produce el mismo SHA-256 que el resto de la organización calcula sobre el mismo texto', () => {
    // Vector conocido: sha256("") = e3b0c4...
    assert.equal(
      sha256(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('reemplaza sólo el valor hexadecimal, conservando el resto del archivo', () => {
    const source = [
      "const EXPECTED_PUBLIC_SPEC_SHA256 =",
      "  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
      '',
      'otraLinea();',
    ].join('\n');
    const updated = replaceExpectedSha(source, 'b'.repeat(64));
    assert.match(updated, /'b{64}';/);
    assert.match(updated, /otraLinea\(\);/);
  });

  it('falla con un mensaje claro si no encuentra la declaración', () => {
    assert.throws(() => replaceExpectedSha('sin la constante', 'a'.repeat(64)), /EXPECTED_PUBLIC_SPEC_SHA256/);
  });
});

describe('diffField', () => {
  it('reporta un campo nuevo', () => {
    const lines = diffField('foo', undefined, { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /campo nuevo `foo`/);
  });

  it('reporta un campo retirado', () => {
    const lines = diffField('foo', { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false }, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /campo retirado `foo`/);
  });

  it('reporta un maxLength que cambió y calla lo que no cambió', () => {
    const before = { type: 'string', nullable: false, required: true, isUnion: false, isContainer: false, maxLength: 100 } as const;
    const after = { ...before, maxLength: 255 };
    const lines = diffField('description', before, after);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /maxLength 100 → 255/);

    assert.deepEqual(diffField('description', before, { ...before }), []);
  });
});

describe('buildSummary', () => {
  it('sin versión anterior, lo dice y no intenta diferenciar', () => {
    const summary = buildSummary(undefined, documentWith({ foo: {} }));
    assert.match(summary, /No hay una versión anterior/);
  });

  it('lista operaciones nuevas y retiradas por su ubicación', () => {
    const previous = documentWith({ getFoo: {}, getBar: {} });
    const next = documentWith({ getFoo: {}, getBaz: {} });
    const summary = buildSummary(previous, next);
    assert.match(summary, /### Operaciones nuevas\n- `getBaz`/);
    assert.match(summary, /### Operaciones retiradas\n- `getBar`/);
  });

  it('describe el cambio de un límite en una operación que sigue existiendo', () => {
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
  it('detecta respuestas y seguridad nuevas', () => {
    const previous = documentWith({
      op: { responses: { '200': {} }, security: [{ ApiKeyAuth: [] }] },
    });
    const next = documentWith({
      op: { responses: { '200': {}, '429': {} }, security: [] },
    });
    const lines = diffOperation(previous, next, 'op');
    assert.ok(lines.some((line) => line.includes('respuestas nuevas: 429')));
    assert.ok(lines.some((line) => line.includes('seguridad:')));
  });

  it('sin cambios, no reporta nada', () => {
    const document = documentWith({ op: { responses: { '200': {} } } });
    assert.deepEqual(diffOperation(document, document, 'op'), []);
  });
});

describe('operationResponseCodes y operationSecurity', () => {
  it('leen las respuestas y la seguridad declaradas por la operación', () => {
    const document = documentWith({
      op: { responses: { '200': {}, '404': {} }, security: [{ ApiKeyAuth: [] }] },
    });
    assert.deepEqual([...operationResponseCodes(document, 'op')].sort(), ['200', '404']);
    assert.deepEqual(operationSecurity(document, 'op'), [{ ApiKeyAuth: [] }]);
  });

  it('una operación sin seguridad propia hereda la global', () => {
    const document = documentWith({ op: { responses: {} } });
    assert.deepEqual(operationSecurity(document, 'op'), [{ ApiKeyAuth: [] }]);
  });
});
