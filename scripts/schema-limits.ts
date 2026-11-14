
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

/** Resuelve un `$ref` interno (`#/components/...`) contra el documento raíz. */
function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith('#/')) {
    throw new Error(`No se admite un $ref externo: ${ref}`);
  }
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (!isRecord(node)) throw new Error(`El $ref no tiene destino: ${ref}`);
    node = node[part];
  }
  if (!isRecord(node)) throw new Error(`El $ref no tiene destino: ${ref}`);
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

/** Reduce un `anyOf`/`oneOf` de dos ramas, una de ellas `{"type":"null"}`, a la rama útil, marcada `nullable`. */
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

/** Convierte un nodo de JSON Schema (del spec o de `z.toJSONSchema`) en una restricción comparable. */
export function toConstraint(root: Json, rawNode: Json, required: boolean): FieldConstraint {
  const { node, nullable, isUnion } = stripNullable(root, rawNode);
  const type = typeOf(node);
  // Sólo un objeto anidado se trata como opaco (ver la nota de alcance al inicio
  // del archivo); un arreglo se compara, incluido el tipo de sus elementos, en
  // compareScalar.
  const isContainer = type === 'object';

  // `exclusiveMinimum`/`exclusiveMaximum` (lo que produce `z.number().positive()`,
  // por ejemplo) se normalizan a `minimum`/`maximum` inclusivos. En enteros
  // el límite exclusivo N equivale al inclusivo N±1; en números de punto flotante
  // no hay un límite inclusivo exacto, así que se conserva el mismo valor (una
  // aproximación conservadora: puede reportar un `missing` de más, nunca de menos).
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
 * Campos cuyo nombre en el catálogo MCP no es una variante mecánica
 * (snake_case/camelCase) del nombre del spec. Hoy ninguno: las entradas de las
 * herramientas usan los nombres de campo de la API.
 */
const NAME_ALIASES: Record<string, string> = {
};

/** Une parámetros (ruta/consulta/encabezado) y propiedades del cuerpo en un solo mapa plano, como hace cada herramienta. */
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

/** El JSON Schema plano de un `inputSchema` de Zod, con la misma forma que `specOperationFields`. */
export function toolOperationFields(tool: ToolDefinition): Map<string, FieldConstraint> {
  const schemaDocument = z.toJSONSchema(tool.inputSchema, { target: 'draft-2020-12' }) as Json;
  const fields = new Map<string, FieldConstraint>();
  const properties = isRecord(schemaDocument.properties) ? schemaDocument.properties : {};
  const required = new Set((schemaDocument.required as string[] | undefined) ?? []);
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (!isRecord(rawProperty)) continue;
    // `z.foo().default(x)` (sin `.optional()`) cae en la lista `required`
    // del JSON Schema que produce Zod, aunque quien llama pueda omitirlo: el
    // valor por omisión lo cubre. Para esta comparación cuenta como opcional.
    const hasDefault = rawProperty.default !== undefined;
    fields.set(name, toConstraint(schemaDocument, rawProperty, required.has(name) && !hasDefault));
  }
  return fields;
}

/** Primera pasada: el nombre exacto (alias o mecánico) de un campo del spec en el esquema de Zod. */
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
 * Segunda pasada, sólo para lo que la primera dejó sin pareja.
 *
 * El identificador del recurso de una ruta (`id`, `row_id`...) casi siempre es
 * genérico en el spec y explícito en el catálogo MCP (`webhook_id`,
 * `validation_id`...). Si, tras la primera pasada, queda sin reclamar exactamente
 * un campo obligatorio de Zod del mismo tipo base (`string`/`object`), se
 * empareja con él.
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
      detail: `el spec declara «${spec.type}» y el esquema MCP «${zod.type}»`,
    });
    return;
  }

  if (spec.required && !zod.required) {
    findings.push({ operationId, field, kind: 'missing', detail: 'el spec lo exige y el esquema MCP no' });
  } else if (!spec.required && zod.required) {
    findings.push({ operationId, field, kind: 'extra', detail: 'el esquema MCP lo exige y el spec no' });
  }

  if (spec.enum) {
    const specSet = new Set(spec.enum.map((value) => JSON.stringify(value)));
    const zodSet = new Set((zod.enum ?? []).map((value) => JSON.stringify(value)));
    const missing = [...specSet].filter((value) => !zodSet.has(value));
    const extra = [...zodSet].filter((value) => !specSet.has(value));
    if (missing.length) {
      findings.push({ operationId, field, kind: 'missing', detail: `faltan valores del enum: ${missing.join(', ')}` });
    }
    if (extra.length) {
      findings.push({ operationId, field, kind: 'extra', detail: `sobran valores del enum: ${extra.join(', ')}` });
    }
  }

  // Un `pattern` propio en el esquema de Zod es la validación que manda para
  // ese campo (ver la nota de alcance al inicio del archivo): no se compara
  // ni con el `pattern` del spec ni con su minLength/maxLength.
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
        detail: `maxLength ${zod.maxLength} es más estricto que el spec (${spec.maxLength})`,
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
        detail: `minLength ${zod.minLength} es más estricto que el spec (${spec.minLength})`,
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
        detail: `maximum ${zod.maximum} es más estricto que el spec (${spec.maximum})`,
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
        detail: `minimum ${zod.minimum} es más estricto que el spec (${spec.minimum})`,
      });
    }
  }

  if (spec.pattern !== undefined && spec.pattern !== zod.pattern) {
    findings.push({
      operationId,
      field,
      kind: zod.pattern === undefined ? 'missing' : 'mismatch',
      detail: `pattern del spec: ${spec.pattern}; MCP: ${zod.pattern ?? 'ninguno'}`,
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

  // Primera pasada: nombre exacto (alias o mecánico) para cada campo. Deja lo que
  // ya coincide por nombre fuera de la carrera de la heurística del "id", sea cual
  // sea el orden en que aparezcan los campos.
  for (const [specName] of specFields) {
    const zodName = matchByName(specName, zodFields, claimed);
    if (zodName) {
      claimed.add(zodName);
      matches.set(specName, zodName);
    }
  }

  // Segunda pasada: lo que queda sin pareja, por la heurística del identificador de recurso.
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
          detail: 'campo que exige el spec, ausente del esquema MCP',
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
        findings.push({ operationId, field: specName, kind: 'missing', detail: 'el spec lo exige y el esquema MCP no' });
      } else if (!spec.required && zod.required) {
        findings.push({ operationId, field: specName, kind: 'extra', detail: 'el esquema MCP lo exige y el spec no' });
      }
      continue;
    }

    compareScalar(operationId, specName, spec, zod, findings);
  }

  return findings;
}

/** Nombres anteriores que la API aún acepta como alias obsoletos; se expone el nombre en inglés. */
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
 * Campos opcionales del spec que el esquema MCP no expone. No son una desviación, porque el
 * catálogo puede dejar fuera un filtro, pero cada uno es una decisión que alguien debe
 * poder ver; la prueba fija la lista aceptada.
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
        detail: 'no está en el spec público',
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
