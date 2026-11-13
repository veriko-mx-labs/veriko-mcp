
import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { ToolDefinition } from '../src/catalog.js';

export type Json = Record<string, unknown>;

export interface FieldConstraint {
  type?: string;
  nullable: boolean;
  required: boolean;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  isUnion: boolean;
  isContainer: boolean;
  items?: FieldConstraint;
  minItems?: number;
  maxItems?: number;
}

export interface Finding {
  operationId: string;
  field: string;
  kind: 'missing' | 'extra' | 'mismatch' | 'unmapped';
  detail: string;
}

const BOOLEAN_TOKENS = new Set(['0', '1', 'true', 'false', 'yes', '']);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves an internal `$ref` (`#/components/...`) against the root document. */
function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith('#/')) {
    throw new Error(`External $ref is not supported: ${ref}`);
  }
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (!isRecord(node)) throw new Error(`$ref has no target: ${ref}`);
    node = node[part];
  }
  if (!isRecord(node)) throw new Error(`$ref has no target: ${ref}`);
  return node;
}

function resolve(root: Json, node: Json): Json {
  if (typeof node.$ref === 'string') {
    return resolve(root, resolveRef(root, node.$ref));
  }
  if (Array.isArray(node.allOf)) {
    const merged: Json = {};
    const requiredParts: string[] = [];
    for (const part of node.allOf as unknown[]) {
      if (!isRecord(part)) continue;
      const resolved = resolve(root, part);
      Object.assign(merged, resolved);
      if (Array.isArray(resolved.required)) {
        requiredParts.push(...(resolved.required as string[]));
      }
    }
    if (requiredParts.length) merged.required = requiredParts;
    return merged;
  }
  return node;
}

/** Reduces a two-branch `anyOf`/`oneOf` where one branch is `{"type":"null"}` to the useful branch, marked `nullable`. */
function stripNullable(root: Json, node: Json): { node: Json; nullable: boolean; isUnion: boolean } {
  const resolved = resolve(root, node);
  const branches = (resolved.anyOf ?? resolved.oneOf) as unknown[] | undefined;
  if (!Array.isArray(branches)) {
    return { node: resolved, nullable: false, isUnion: false };
  }
  const resolvedBranches = branches.filter(isRecord).map((branch) => resolve(root, branch));
  const nonNull = resolvedBranches.filter((branch) => branch.type !== 'null');
  const hasNull = resolvedBranches.length !== nonNull.length;
  if (nonNull.length === 1) {
    return { node: nonNull[0]!, nullable: hasNull, isUnion: false };
  }
  return { node: resolved, nullable: hasNull, isUnion: true };
}

function isBooleanAsStringEnum(node: Json): boolean {
  if (node.type !== 'string' || !Array.isArray(node.enum)) return false;
  return (node.enum as unknown[]).every(
    (value) => typeof value === 'string' && BOOLEAN_TOKENS.has(value),
  );
}

function typeOf(node: Json): string | undefined {
  const { type } = node;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const nonNull = (type as unknown[]).filter((entry) => entry !== 'null');
    if (nonNull.length === 1 && typeof nonNull[0] === 'string') return nonNull[0];
  }
  return undefined;
}

/** Turns a JSON Schema node (from the spec or from `z.toJSONSchema`) into a comparable constraint. */
export function toConstraint(root: Json, rawNode: Json, required: boolean): FieldConstraint {
  const { node, nullable, isUnion } = stripNullable(root, rawNode);
  const type = typeOf(node);
  // Only a nested object is treated as opaque (see the scope note at the top
  // of the file); an array is compared, including the type of its items, in
  // compareScalar.
  const isContainer = type === 'object';

  // `exclusiveMinimum`/`exclusiveMaximum` (what `z.number().positive()` produces,
  // for example) are normalized to inclusive `minimum`/`maximum`. For integers
  // the exclusive bound N equals the inclusive N±1; for floating point numbers
  // there is no exact inclusive bound, so the same value is kept (a conservative
  // approximation: it can report one `missing` too many, never one too few).
  let minimum = typeof node.minimum === 'number' ? node.minimum : undefined;
  let maximum = typeof node.maximum === 'number' ? node.maximum : undefined;
  if (minimum === undefined && typeof node.exclusiveMinimum === 'number') {
    minimum = type === 'integer' ? node.exclusiveMinimum + 1 : node.exclusiveMinimum;
  }
  if (maximum === undefined && typeof node.exclusiveMaximum === 'number') {
    maximum = type === 'integer' ? node.exclusiveMaximum - 1 : node.exclusiveMaximum;
  }

  const constraint: FieldConstraint = {
    type,
    nullable,
    required,
    isUnion,
    isContainer,
    enum: Array.isArray(node.enum) ? (node.enum as unknown[]) : undefined,
    minLength: typeof node.minLength === 'number' ? node.minLength : undefined,
    maxLength: typeof node.maxLength === 'number' ? node.maxLength : undefined,
    minimum,
    maximum,
    pattern: typeof node.pattern === 'string' ? node.pattern : undefined,
    minItems: typeof node.minItems === 'number' ? node.minItems : undefined,
    maxItems: typeof node.maxItems === 'number' ? node.maxItems : undefined,
  };

  if (type === 'array' && isRecord(node.items)) {
    constraint.items = toConstraint(root, node.items, false);
  }

  return constraint;
}

function normalizeName(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

/**
 * Fields whose name in the MCP catalog is not a mechanical variant
 * (snake_case/camelCase) of the spec name. None today: tool inputs use the API
 * field names.
 */
const NAME_ALIASES: Record<string, string> = {
};

/** Joins parameters (path/query/header) and body properties into one flat map, as each tool does. */
export function specOperationFields(
  document: Json,
  operationId: string,
): Map<string, FieldConstraint> | null {
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return null;

  for (const item of Object.values(paths)) {
    for (const rawOperation of Object.values(item)) {
      if (!isRecord(rawOperation) || rawOperation.operationId !== operationId) continue;

      const fields = new Map<string, FieldConstraint>();

      for (const rawParam of (rawOperation.parameters as unknown[] | undefined) ?? []) {
        if (!isRecord(rawParam)) continue;
        const param = resolve(document, rawParam);
        if (param.in === 'cookie') continue;
        const name = param.name as string;
        const schema = isRecord(param.schema) ? param.schema : {};
        fields.set(name, toConstraint(document, schema, param.required === true));
      }

      const requestBody = isRecord(rawOperation.requestBody)
        ? resolve(document, rawOperation.requestBody)
        : undefined;
      const bodySchemaRaw = isRecord(requestBody?.content)
        ? (requestBody.content as Json)['application/json']
        : undefined;
      const bodySchema = isRecord(bodySchemaRaw) ? resolve(document, bodySchemaRaw.schema as Json) : undefined;
      if (bodySchema && isRecord(bodySchema.properties)) {
        const requiredList = new Set((bodySchema.required as string[] | undefined) ?? []);
        for (const [name, rawProperty] of Object.entries(bodySchema.properties as Json)) {
          if (!isRecord(rawProperty)) continue;
          fields.set(name, toConstraint(document, rawProperty, requiredList.has(name)));
        }
      }

      return fields;
    }
  }
  return null;
}

/** The flat JSON Schema of a Zod `inputSchema`, in the same shape as `specOperationFields`. */
export function toolOperationFields(tool: ToolDefinition): Map<string, FieldConstraint> {
  const schemaDocument = z.toJSONSchema(tool.inputSchema, { target: 'draft-2020-12' }) as Json;
  const fields = new Map<string, FieldConstraint>();
  const properties = isRecord(schemaDocument.properties) ? schemaDocument.properties : {};
  const required = new Set((schemaDocument.required as string[] | undefined) ?? []);
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (!isRecord(rawProperty)) continue;
    // `z.foo().default(x)` (without `.optional()`) lands in the `required` list
    // of the JSON Schema Zod produces, although the caller can omit it: the
    // default covers it. For this comparison it counts as optional.
    const hasDefault = rawProperty.default !== undefined;
    fields.set(name, toConstraint(schemaDocument, rawProperty, required.has(name) && !hasDefault));
  }
  return fields;
}

/** First pass: the exact name (alias or mechanical) of a spec field in the Zod schema. */
function matchByName(
  specName: string,
  zodFields: Map<string, FieldConstraint>,
  claimed: Set<string>,
): string | undefined {
  const alias = NAME_ALIASES[specName];
  if (alias && zodFields.has(alias) && !claimed.has(alias)) return alias;
  const normalized = normalizeName(specName);
  for (const zodName of zodFields.keys()) {
    if (claimed.has(zodName)) continue;
    if (normalizeName(zodName) === normalized) return zodName;
  }
  return undefined;
}

/**
 * Second pass, only for what the first left unpaired.
 *
 * The resource identifier of a path (`id`, `row_id`...) is almost always
 * generic in the spec and explicit in the MCP catalog (`webhook_id`,
 * `validation_id`...). If, after the first pass, exactly one required Zod field
 * of the same base type (`string`/`object`) is left unclaimed, it is paired
 * with it.
 */
function matchByUniqueRemainingField(
  spec: FieldConstraint,
  zodFields: Map<string, FieldConstraint>,
  claimed: Set<string>,
): string | undefined {
  const candidates = [...zodFields.entries()].filter(([zodName, zod]) => {
    if (claimed.has(zodName)) return false;
    if (!zod.required) return false;
    if (spec.isContainer) return zod.isContainer;
    return /(?:Id|_id)$/.test(zodName);
  });
  return candidates.length === 1 ? candidates[0]![0] : undefined;
}

function describe(constraint: FieldConstraint): string {
  const parts: string[] = [constraint.type ?? 'no type'];
  if (constraint.required) parts.push('required');
  if (constraint.enum) parts.push(`enum=${JSON.stringify(constraint.enum)}`);
  if (constraint.minLength !== undefined) parts.push(`minLength=${constraint.minLength}`);
  if (constraint.maxLength !== undefined) parts.push(`maxLength=${constraint.maxLength}`);
  if (constraint.minimum !== undefined) parts.push(`minimum=${constraint.minimum}`);
  if (constraint.maximum !== undefined) parts.push(`maximum=${constraint.maximum}`);
  if (constraint.pattern !== undefined) parts.push(`pattern=${constraint.pattern}`);
  if (constraint.minItems !== undefined) parts.push(`minItems=${constraint.minItems}`);
  if (constraint.maxItems !== undefined) parts.push(`maxItems=${constraint.maxItems}`);
  return parts.join(' ');
}

function compareScalar(
  operationId: string,
  field: string,
  spec: FieldConstraint,
  zod: FieldConstraint,
  findings: Finding[],
): void {
  if (spec.type && zod.type && spec.type !== zod.type) {
    findings.push({
      operationId,
      field,
      kind: 'mismatch',
      detail: `the spec declares «${spec.type}» and the MCP schema «${zod.type}»`,
    });
    return;
  }

  if (spec.required && !zod.required) {
    findings.push({ operationId, field, kind: 'missing', detail: 'the spec requires it and the MCP schema does not' });
  } else if (!spec.required && zod.required) {
    findings.push({ operationId, field, kind: 'extra', detail: 'the MCP schema requires it and the spec does not' });
  }

  if (spec.enum) {
    const specSet = new Set(spec.enum.map((value) => JSON.stringify(value)));
    const zodSet = new Set((zod.enum ?? []).map((value) => JSON.stringify(value)));
    const missing = [...specSet].filter((value) => !zodSet.has(value));
    const extra = [...zodSet].filter((value) => !specSet.has(value));
    if (missing.length) {
      findings.push({ operationId, field, kind: 'missing', detail: `missing enum values: ${missing.join(', ')}` });
    }
    if (extra.length) {
      findings.push({ operationId, field, kind: 'extra', detail: `extra enum values: ${extra.join(', ')}` });
    }
  }

  // A `pattern` of its own in the Zod schema is the authoritative validation for
  // that field (see the scope note at the top of the file): it is compared
  // neither with the spec `pattern` nor with its minLength/maxLength.
  if (zod.pattern !== undefined) {
    return;
  }

  if (spec.maxLength !== undefined) {
    if (zod.maxLength === undefined || zod.maxLength > spec.maxLength) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `maxLength ${spec.maxLength} (MCP: ${zod.maxLength ?? 'no limit'})`,
      });
    } else if (zod.maxLength < spec.maxLength) {
      findings.push({
        operationId,
        field,
        kind: 'extra',
        detail: `maxLength ${zod.maxLength} is stricter than the spec (${spec.maxLength})`,
      });
    }
  }

  if (spec.minLength !== undefined && spec.minLength > 0) {
    if (zod.minLength === undefined || zod.minLength < spec.minLength) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `minLength ${spec.minLength} (MCP: ${zod.minLength ?? 'no minimum'})`,
      });
    } else if (zod.minLength > spec.minLength) {
      findings.push({
        operationId,
        field,
        kind: 'extra',
        detail: `minLength ${zod.minLength} is stricter than the spec (${spec.minLength})`,
      });
    }
  }

  if (spec.maximum !== undefined) {
    if (zod.maximum === undefined || zod.maximum > spec.maximum) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `maximum ${spec.maximum} (MCP: ${zod.maximum ?? 'no limit'})`,
      });
    } else if (zod.maximum < spec.maximum) {
      findings.push({
        operationId,
        field,
        kind: 'extra',
        detail: `maximum ${zod.maximum} is stricter than the spec (${spec.maximum})`,
      });
    }
  }

  if (spec.minimum !== undefined) {
    if (zod.minimum === undefined || zod.minimum < spec.minimum) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `minimum ${spec.minimum} (MCP: ${zod.minimum ?? 'no minimum'})`,
      });
    } else if (zod.minimum > spec.minimum) {
      findings.push({
        operationId,
        field,
        kind: 'extra',
        detail: `minimum ${zod.minimum} is stricter than the spec (${spec.minimum})`,
      });
    }
  }

  if (spec.pattern !== undefined && spec.pattern !== zod.pattern) {
    findings.push({
      operationId,
      field,
      kind: zod.pattern === undefined ? 'missing' : 'mismatch',
      detail: `spec pattern: ${spec.pattern}; MCP: ${zod.pattern ?? 'none'}`,
    });
  }

  if (spec.type === 'array') {
    if (spec.minItems !== undefined && (zod.minItems === undefined || zod.minItems < spec.minItems)) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `minItems ${spec.minItems} (MCP: ${zod.minItems ?? 'no minimum'})`,
      });
    }
    if (spec.maxItems !== undefined && (zod.maxItems === undefined || zod.maxItems > spec.maxItems)) {
      findings.push({
        operationId,
        field,
        kind: 'missing',
        detail: `maxItems ${spec.maxItems} (MCP: ${zod.maxItems ?? 'no limit'})`,
      });
    }
    if (spec.items && zod.items && !spec.items.isUnion && !zod.items.isUnion) {
      compareScalar(operationId, `${field}[]`, spec.items, zod.items, findings);
    }
  }
}

export function compareOperation(
  operationId: string,
  specFields: Map<string, FieldConstraint>,
  zodFields: Map<string, FieldConstraint>,
): Finding[] {
  const findings: Finding[] = [];
  const claimed = new Set<string>();
  const matches = new Map<string, string>();

  // First pass: exact name (alias or mechanical) for every field. It keeps what
  // already matches by name out of the race of the "id" heuristic, whatever
  // order the fields appear in.
  for (const [specName] of specFields) {
    const zodName = matchByName(specName, zodFields, claimed);
    if (zodName) {
      claimed.add(zodName);
      matches.set(specName, zodName);
    }
  }

  // Second pass: what is left unpaired, by the resource-identifier heuristic.
  for (const [specName, spec] of specFields) {
    if (matches.has(specName)) continue;
    const zodName = matchByUniqueRemainingField(spec, zodFields, claimed);
    if (zodName) {
      claimed.add(zodName);
      matches.set(specName, zodName);
    }
  }

  for (const [specName, spec] of specFields) {
    const zodName = matches.get(specName);
    if (!zodName) {
      if (spec.required) {
        findings.push({
          operationId,
          field: specName,
          kind: 'missing',
          detail: 'field required by the spec, absent from the MCP schema',
        });
      }
      continue;
    }
    const zod = zodFields.get(zodName)!;

    if (spec.isUnion || zod.isUnion || isBooleanAsStringEnum({ type: spec.type, enum: spec.enum } as Json)) {
      continue;
    }
    if (spec.isContainer || zod.isContainer) {
      if (spec.required && !zod.required) {
        findings.push({ operationId, field: specName, kind: 'missing', detail: 'the spec requires it and the MCP schema does not' });
      } else if (!spec.required && zod.required) {
        findings.push({ operationId, field: specName, kind: 'extra', detail: 'the MCP schema requires it and the spec does not' });
      }
      continue;
    }

    compareScalar(operationId, specName, spec, zod, findings);
  }

  return findings;
}

/** Spanish names the API still accepts as deprecated aliases; the English name is the one to expose. */
const DEPRECATED_ALIASES = new Set([
  'fecha',
  'monto',
  'clave_rastreo',
  'referencia_numerica',
  'emisor',
  'receptor',
  'cuenta_beneficiaria',
  'cuentas_candidatas',
  'receptor_participante',
  'banco_emisor',
  'banco_receptor',
]);

/**
 * Optional spec fields the MCP schema does not expose. Not drift, since the
 * catalog may leave a filter out, but each one is a decision someone should be
 * able to see; the test pins the accepted list.
 */
export function missingOptionalFields(
  operationId: string,
  specFields: Map<string, FieldConstraint>,
  zodFields: Map<string, FieldConstraint>,
): string[] {
  const claimed = new Set<string>();
  const missing: string[] = [];
  for (const [specName, spec] of specFields) {
    const zodName = matchByName(specName, zodFields, claimed);
    if (zodName) {
      claimed.add(zodName);
      continue;
    }
    if (!spec.required && !DEPRECATED_ALIASES.has(specName)) missing.push(`${operationId}.${specName}`);
  }
  return missing;
}

export function loadSpecDocument(path: string): Json {
  return parseYaml(readFileSync(path, 'utf8')) as Json;
}

export function checkCatalogAgainstSpec(document: Json, catalog: readonly ToolDefinition[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of catalog) {
    const specFields = specOperationFields(document, tool.operationId);
    if (!specFields) {
      findings.push({
        operationId: tool.operationId,
        field: '(operation)',
        kind: 'unmapped',
        detail: 'not found in the public spec',
      });
      continue;
    }
    const zodFields = toolOperationFields(tool);
    findings.push(...compareOperation(tool.operationId, specFields, zodFields));
  }
  return findings;
}

export function optionalFieldGaps(document: Json, catalog: readonly ToolDefinition[]): string[] {
  const gaps: string[] = [];
  for (const tool of catalog) {
    const specFields = specOperationFields(document, tool.operationId);
    if (!specFields) continue;
    gaps.push(...missingOptionalFields(tool.operationId, specFields, toolOperationFields(tool)));
  }
  return gaps.sort();
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.operationId}.${finding.field}: [${finding.kind}] ${finding.detail}`)
    .join('\n');
}
