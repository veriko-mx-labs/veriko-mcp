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

function assertNoInternalExtensions(value: unknown, location = 'document'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInternalExtensions(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EXTENSION_KEYS.has(key)) {
      throw new Error(`The public OpenAPI contains ${key} at ${location}.`);
    }
    assertNoInternalExtensions(child, `${location}.${key}`);
  }
}

function assertApiKeySecurity(security: unknown, location: string): void {
  if (!Array.isArray(security)) {
    throw new Error(`${location} does not declare a valid security array.`);
  }
  if (security.length === 0) return;

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new Error(`${location} contains an invalid security requirement.`);
    }
    const entries = Object.entries(requirement);
    if (entries.length !== 1 || entries[0]?.[0] !== 'ApiKeyAuth') {
      throw new Error(`${location} allows authentication other than ApiKeyAuth.`);
    }
    const scopes = entries[0][1];
    if (!Array.isArray(scopes) || scopes.length !== 0) {
      throw new Error(`${location} declares unexpected scopes for ApiKeyAuth.`);
    }
  }
}

function assertSecurityScheme(document: OpenApiDocument): void {
  const schemes = document.components?.securitySchemes;
  if (!schemes || Object.keys(schemes).length !== 1 || !('ApiKeyAuth' in schemes)) {
    throw new Error('The public OpenAPI must declare only ApiKeyAuth.');
  }

  const apiKey = schemes.ApiKeyAuth;
  if (!apiKey || typeof apiKey !== 'object' || Array.isArray(apiKey)) {
    throw new Error('ApiKeyAuth is not a valid security scheme.');
  }
  const fields = apiKey as Record<string, unknown>;
  if (fields.type !== 'apiKey' || fields.in !== 'header' || fields.name !== 'Authorization') {
    throw new Error('ApiKeyAuth must be an API key in the Authorization header.');
  }
}

/**
 * Compares the public spec with the catalog. `expectedOperationIds` are the
 * operations with an adapter and `notExposed` those the catalog decides not to
 * announce: together they must be exactly the operations of the spec.
 */
export function assertPublicM2MSurface(
  input: unknown,
  expectedOperationIds: readonly string[],
  expectedCount = 75,
  notExposed: readonly string[] = [],
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The public OpenAPI is not an object.');
  }
  const document = input as OpenApiDocument;
  assertNoInternalExtensions(document);
  assertSecurityScheme(document);
  assertApiKeySecurity(document.security, 'The global security');

  const actual = new Map<string, string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method] as Operation | undefined;
      if (!operation) continue;

      const location = `${method.toUpperCase()} ${path}`;
      if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
        throw new Error(`${location} has no operationId.`);
      }
      const previous = actual.get(operation.operationId);
      if (previous) {
        throw new Error(
          `Duplicate operationId ${operation.operationId}: ${previous} and ${location}.`,
        );
      }
      actual.set(operation.operationId, location);
      assertApiKeySecurity(operation.security ?? document.security, location);
    }
  }

  const exposed = new Set(expectedOperationIds);
  if (exposed.size !== expectedOperationIds.length) {
    throw new Error('The MCP catalog contains duplicate operationId values.');
  }
  const withAdapter = notExposed.filter((operationId) => exposed.has(operationId)).sort();
  if (withAdapter.length) {
    throw new Error(`Operations that are not exposed but have an adapter: ${withAdapter.join(', ')}`);
  }
  const expected = new Set([...exposed, ...notExposed]);

  const missing = [...actual.keys()].filter((operationId) => !expected.has(operationId)).sort();
  const obsolete = [...expected].filter((operationId) => !actual.has(operationId)).sort();
  if (missing.length || obsolete.length) {
    const lines = [
      missing.length ? `Missing MCP adapters: ${missing.join(', ')}` : '',
      obsolete.length ? `Obsolete MCP adapters: ${obsolete.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(lines.join('\n'));
  }

  if (actual.size !== expectedCount) {
    throw new Error(
      `The public surface has ${actual.size} operations; ${expectedCount} were expected.`,
    );
  }
}
