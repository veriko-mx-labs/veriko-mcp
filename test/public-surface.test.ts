import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublicM2MSurface } from '../scripts/public-surface.js';
import { NOT_EXPOSED_OPERATIONS, OPERATION_TOOLS } from '../src/catalog.js';

function validDocument(): Record<string, unknown> {
  const operationIds = [
    ...OPERATION_TOOLS.map((tool) => tool.operationId),
    ...NOT_EXPOSED_OPERATIONS,
  ];
  return {
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'Authorization' },
      },
    },
    paths: Object.fromEntries(
      operationIds.map((operationId, index) => [
        `/operation-${index}`,
        { get: { operationId } },
      ]),
    ),
  };
}

function validate(
  document: Record<string, unknown>,
  notExposed: readonly string[] = NOT_EXPOSED_OPERATIONS,
): void {
  assertPublicM2MSurface(
    document,
    OPERATION_TOOLS.map((tool) => tool.operationId),
    OPERATION_TOOLS.length + NOT_EXPOSED_OPERATIONS.length,
    notExposed,
  );
}

describe('public surface', () => {
  it('accepts only an API key and allows explicit public operations', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-0']!.get.security = [];
    assert.doesNotThrow(() => validate(document));
  });

  it('rejects paths without an operationId', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    delete paths['/operation-0']!.get.operationId;
    assert.throws(() => validate(document), /GET \/operation-0 has no operationId/);
  });

  it('rejects duplicate operationId values', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-1']!.get.operationId = OPERATION_TOOLS[0]!.operationId;
    assert.throws(() => validate(document), /Duplicate operationId/);
  });

  it('rejects cookies and any scheme other than ApiKeyAuth', () => {
    const document = validDocument();
    const components = document.components as {
      securitySchemes: Record<string, unknown>;
    };
    components.securitySchemes.CookieAuth = { type: 'apiKey', in: 'cookie', name: 'session' };
    assert.throws(() => validate(document), /only ApiKeyAuth/);
  });

  it('rejects internal extensions even when nested', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-0']!.get['x-integration'] = 'hidden';
    assert.throws(() => validate(document), /contains x-integration/);
  });

  it('counts the operations the catalog decides not to expose', () => {
    assert.doesNotThrow(() => validate(validDocument()));
    assert.equal(OPERATION_TOOLS.length + NOT_EXPOSED_OPERATIONS.length, 75);
  });

  it('rejects a spec operation with no adapter that is not declared as not exposed', () => {
    assert.throws(() => validate(validDocument(), []), /Missing MCP adapters: /);
  });

  it('rejects a not-exposed operation the spec no longer declares', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    const hidden = Object.entries(paths).find(
      ([, item]) => item.get.operationId === NOT_EXPOSED_OPERATIONS[0],
    );
    assert.ok(hidden);
    delete paths[hidden[0]];
    assert.throws(
      () => assertPublicM2MSurface(document, OPERATION_TOOLS.map((tool) => tool.operationId), 72, NOT_EXPOSED_OPERATIONS),
      /Obsolete MCP adapters: /,
    );
  });

  it('rejects an operation declared as not exposed that has an adapter', () => {
    const exposed = OPERATION_TOOLS[0]!.operationId;
    assert.throws(
      () => validate(validDocument(), [...NOT_EXPOSED_OPERATIONS, exposed] as never),
      /not exposed but have an adapter/,
    );
  });
});
