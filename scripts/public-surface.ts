const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
const FORBIDDEN_EXTENSION_KEYS = new Set([
  'x-auth',
  'x-integration',
  'x-visibility',
  'x-permission',
  'x-admin-notes',
]);

interface Operation {
  operationId?: unknown;
  security?: unknown;
}

interface OpenApiDocument {
  security?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
  };
}

function assertNoInternalExtensions(value: unknown, location = 'documento'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInternalExtensions(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EXTENSION_KEYS.has(key)) {
      throw new Error(`El OpenAPI público contiene ${key} en ${location}.`);
    }
    assertNoInternalExtensions(child, `${location}.${key}`);
  }
}

function assertApiKeySecurity(security: unknown, location: string): void {
  if (!Array.isArray(security)) {
    throw new Error(`${location} no declara un arreglo security válido.`);
  }
  if (security.length === 0) return;

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new Error(`${location} contiene un requisito security inválido.`);
    }
    const entries = Object.entries(requirement);
    if (entries.length !== 1 || entries[0]?.[0] !== 'ApiKeyAuth') {
      throw new Error(`${location} admite autenticación distinta de ApiKeyAuth.`);
    }
    const scopes = entries[0][1];
    if (!Array.isArray(scopes) || scopes.length !== 0) {
      throw new Error(`${location} declara scopes inesperados para ApiKeyAuth.`);
    }
  }
}

function assertSecurityScheme(document: OpenApiDocument): void {
  const schemes = document.components?.securitySchemes;
  if (!schemes || Object.keys(schemes).length !== 1 || !('ApiKeyAuth' in schemes)) {
    throw new Error('El OpenAPI público debe declarar únicamente ApiKeyAuth.');
  }

  const apiKey = schemes.ApiKeyAuth;
  if (!apiKey || typeof apiKey !== 'object' || Array.isArray(apiKey)) {
    throw new Error('ApiKeyAuth no es un esquema de seguridad válido.');
  }
  const fields = apiKey as Record<string, unknown>;
  if (fields.type !== 'apiKey' || fields.in !== 'header' || fields.name !== 'Authorization') {
    throw new Error('ApiKeyAuth debe ser una API key en la cabecera Authorization.');
  }
}

export function assertPublicM2MSurface(
  input: unknown,
  expectedOperationIds: readonly string[],
  expectedCount = 66,
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('El OpenAPI público no es un objeto.');
  }
  const document = input as OpenApiDocument;
  assertNoInternalExtensions(document);
  assertSecurityScheme(document);
  assertApiKeySecurity(document.security, 'La seguridad global');

  const actual = new Map<string, string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method] as Operation | undefined;
      if (!operation) continue;

      const location = `${method.toUpperCase()} ${path}`;
      if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
        throw new Error(`${location} no tiene operationId.`);
      }
      const previous = actual.get(operation.operationId);
      if (previous) {
        throw new Error(
          `operationId duplicado ${operation.operationId}: ${previous} y ${location}.`,
        );
      }
      actual.set(operation.operationId, location);
      assertApiKeySecurity(operation.security ?? document.security, location);
    }
  }

  const expected = new Set(expectedOperationIds);
  if (expected.size !== expectedOperationIds.length) {
    throw new Error('El catálogo MCP contiene operationId duplicados.');
  }

  const missing = [...actual.keys()].filter((operationId) => !expected.has(operationId)).sort();
  const obsolete = [...expected].filter((operationId) => !actual.has(operationId)).sort();
  if (missing.length || obsolete.length) {
    const lines = [
      missing.length ? `Faltan adaptadores MCP: ${missing.join(', ')}` : '',
      obsolete.length ? `Sobran adaptadores MCP: ${obsolete.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(lines.join('\n'));
  }

  if (actual.size !== expectedCount) {
    throw new Error(
      `La superficie pública tiene ${actual.size} operaciones; se esperaban ${expectedCount}.`,
    );
  }
}
