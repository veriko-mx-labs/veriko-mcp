import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublicM2MSurface } from '../scripts/public-surface.js';
import { NOT_EXPOSED_OPERATIONS, TOOL_CATALOG } from '../src/catalog.js';

function validDocument(): Record<string, unknown> {
  const operationIds = [
    ...TOOL_CATALOG.map((tool) => tool.operationId),
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
    TOOL_CATALOG.map((tool) => tool.operationId),
    TOOL_CATALOG.length + NOT_EXPOSED_OPERATIONS.length,
    notExposed,
  );
}

describe('superficie pública', () => {
  it('acepta sólo clave de API y permite operaciones públicas explícitas', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-0']!.get.security = [];
    assert.doesNotThrow(() => validate(document));
  });

  it('rechaza rutas sin operationId', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    delete paths['/operation-0']!.get.operationId;
    assert.throws(() => validate(document), /GET \/operation-0 no tiene operationId/);
  });

  it('rechaza operationId duplicados', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-1']!.get.operationId = TOOL_CATALOG[0]!.operationId;
    assert.throws(() => validate(document), /operationId duplicado/);
  });

  it('rechaza cookies y cualquier esquema distinto de ApiKeyAuth', () => {
    const document = validDocument();
    const components = document.components as {
      securitySchemes: Record<string, unknown>;
    };
    components.securitySchemes.CookieAuth = { type: 'apiKey', in: 'cookie', name: 'session' };
    assert.throws(() => validate(document), /únicamente ApiKeyAuth/);
  });

  it('rechaza extensiones internas aunque estén anidadas', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    paths['/operation-0']!.get['x-integration'] = 'hidden';
    assert.throws(() => validate(document), /contiene x-integration/);
  });

  it('cuenta las operaciones que el catálogo decide no exponer', () => {
    assert.doesNotThrow(() => validate(validDocument()));
    assert.equal(TOOL_CATALOG.length + NOT_EXPOSED_OPERATIONS.length, 69);
  });

  it('rechaza una operación del spec sin adaptador que no está declarada como no expuesta', () => {
    assert.throws(() => validate(validDocument(), []), /Faltan adaptadores MCP: /);
  });

  it('rechaza una operación no expuesta que el spec ya no declara', () => {
    const document = validDocument();
    const paths = document.paths as Record<string, { get: Record<string, unknown> }>;
    const hidden = Object.entries(paths).find(
      ([, item]) => item.get.operationId === NOT_EXPOSED_OPERATIONS[0],
    );
    assert.ok(hidden);
    delete paths[hidden[0]];
    assert.throws(
      () => assertPublicM2MSurface(document, TOOL_CATALOG.map((tool) => tool.operationId), 68, NOT_EXPOSED_OPERATIONS),
      /Sobran adaptadores MCP: /,
    );
  });

  it('rechaza una operación declarada como no expuesta que tiene adaptador', () => {
    const exposed = TOOL_CATALOG[0]!.operationId;
    assert.throws(
      () => validate(validDocument(), [...NOT_EXPOSED_OPERATIONS, exposed] as never),
      /no expuestas que tienen adaptador/,
    );
  });
});
