import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublicM2MSurface } from '../scripts/public-surface.js';
import { TOOL_CATALOG } from '../src/catalog.js';

function validDocument(): Record<string, unknown> {
  return {
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'Authorization' },
      },
    },
    paths: Object.fromEntries(
      TOOL_CATALOG.map((tool, index) => [
        `/operation-${index}`,
        { get: { operationId: tool.operationId } },
      ]),
    ),
  };
}

function validate(document: Record<string, unknown>): void {
  assertPublicM2MSurface(
    document,
    TOOL_CATALOG.map((tool) => tool.operationId),
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
});
