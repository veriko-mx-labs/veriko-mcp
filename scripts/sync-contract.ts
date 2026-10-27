/**
 * Comando de regeneración que corre `sync-public-spec.yml` después de que el
 * reusable de la organización escribe el spec nuevo en `spec/openapi.yaml`,
 * antes de que se abra o actualice el PR.
 *
 * Hace tres cosas:
 *
 * 1. Recalcula el SHA-256 del contrato y lo fija en
 *    `EXPECTED_PUBLIC_SPEC_SHA256` (`scripts/check-public-surface.ts`), para
 *    que ese candado valide el contrato nuevo en vez de cortar el paso antes
 *    de que exista un PR que revisar.
 * 2. Compara el contrato anterior (el que tenía `main`, vía
 *    `git show HEAD:spec/openapi.yaml`) contra el nuevo y escribe un resumen
 *    en Markdown, operación por operación, en `VERIKO_SYNC_SUMMARY_FILE` si
 *    la variable está definida (si no, en stdout).
 * 3. Regenera la tabla de costo por perfil del README (`npm run
 *    measure:catalog`).
 *
 * No valida nada: eso ya lo hacen `npm test` (incluido el candado de
 * límites) y `npm run check:surface` como parte del CI del PR. Si esta
 * regeneración fallara con `set -e`, el PR nunca llegaría a abrirse — el
 * problema original que este script corrige.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { type FieldConstraint, type Json, specOperationFields } from './schema-limits.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const specPath = `${root}spec/openapi.yaml`;
const checkSurfacePath = `${root}scripts/check-public-surface.ts`;
const readmePath = `${root}README.md`;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function previousSpecDocument(): Json | undefined {
  try {
    const text = execSync('git show HEAD:spec/openapi.yaml', { cwd: root, encoding: 'utf8' });
    return parseYaml(text) as Json;
  } catch {
    return undefined;
  }
}

const EXPECTED_SHA_PATTERN = /(const EXPECTED_PUBLIC_SPEC_SHA256 =\s*\n\s*')[0-9a-f]{64}(';)/;

export function replaceExpectedSha(source: string, newSha: string): string {
  if (!EXPECTED_SHA_PATTERN.test(source)) {
    throw new Error('No encontré la declaración de EXPECTED_PUBLIC_SPEC_SHA256.');
  }
  return source.replace(EXPECTED_SHA_PATTERN, `$1${newSha}$2`);
}

export function updateExpectedSha(newSha: string): void {
  const source = readFileSync(checkSurfacePath, 'utf8');
  writeFileSync(checkSurfacePath, replaceExpectedSha(source, newSha));
}

export function allOperationIds(document: Json): Set<string> {
  const ids = new Set<string>();
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  for (const item of Object.values(paths ?? {})) {
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object' && typeof (operation as Json).operationId === 'string') {
        ids.add((operation as Json).operationId as string);
      }
    }
  }
  return ids;
}

export function operationLocation(document: Json, operationId: string): string | undefined {
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  for (const [path, item] of Object.entries(paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation && typeof operation === 'object' && (operation as Json).operationId === operationId) {
        return `${method.toUpperCase()} ${path}`;
      }
    }
  }
  return undefined;
}

export function operationResponseCodes(document: Json, operationId: string): Set<string> {
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  for (const item of Object.values(paths ?? {})) {
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object' && (operation as Json).operationId === operationId) {
        const responses = (operation as Json).responses;
        return new Set(responses && typeof responses === 'object' ? Object.keys(responses) : []);
      }
    }
  }
  return new Set();
}

export function operationSecurity(document: Json, operationId: string): unknown {
  const paths = document.paths as Record<string, Record<string, unknown>> | undefined;
  for (const item of Object.values(paths ?? {})) {
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object' && (operation as Json).operationId === operationId) {
        return (operation as Json).security ?? document.security;
      }
    }
  }
  return undefined;
}

function describeFieldConstraint(constraint: FieldConstraint): string {
  const bits: string[] = [constraint.required ? 'requerido' : 'opcional'];
  if (constraint.type) bits.push(constraint.type);
  if (constraint.enum) bits.push(`enum ${JSON.stringify(constraint.enum)}`);
  if (constraint.maxLength !== undefined) bits.push(`maxLength ${constraint.maxLength}`);
  if (constraint.minLength !== undefined) bits.push(`minLength ${constraint.minLength}`);
  if (constraint.maximum !== undefined) bits.push(`maximum ${constraint.maximum}`);
  if (constraint.minimum !== undefined) bits.push(`minimum ${constraint.minimum}`);
  return bits.join(', ');
}

/** Diferencia dos versiones del mismo campo (spec anterior vs. spec nuevo), no spec contra Zod. */
export function diffField(name: string, before: FieldConstraint | undefined, after: FieldConstraint | undefined): string[] {
  if (!before && after) return [`  - campo nuevo \`${name}\`: ${describeFieldConstraint(after)}`];
  if (before && !after) return [`  - campo retirado \`${name}\``];
  if (!before || !after) return [];

  const changes: string[] = [];
  if (before.required !== after.required) {
    changes.push(after.required ? 'ahora requerido' : 'ahora opcional');
  }
  if (before.type !== after.type) changes.push(`tipo ${before.type ?? '?'} → ${after.type ?? '?'}`);
  if (before.maxLength !== after.maxLength) {
    changes.push(`maxLength ${before.maxLength ?? 'sin límite'} → ${after.maxLength ?? 'sin límite'}`);
  }
  if (before.minLength !== after.minLength) {
    changes.push(`minLength ${before.minLength ?? 'sin mínimo'} → ${after.minLength ?? 'sin mínimo'}`);
  }
  if (before.maximum !== after.maximum) {
    changes.push(`maximum ${before.maximum ?? 'sin límite'} → ${after.maximum ?? 'sin límite'}`);
  }
  if (before.minimum !== after.minimum) {
    changes.push(`minimum ${before.minimum ?? 'sin mínimo'} → ${after.minimum ?? 'sin mínimo'}`);
  }
  if (JSON.stringify(before.enum) !== JSON.stringify(after.enum)) {
    changes.push(`enum ${JSON.stringify(before.enum ?? [])} → ${JSON.stringify(after.enum ?? [])}`);
  }
  if ((before.pattern ?? null) !== (after.pattern ?? null)) {
    changes.push('cambió el patrón de validación');
  }

  return changes.length ? [`  - \`${name}\`: ${changes.join('; ')}`] : [];
}

export function diffOperation(previous: Json, next: Json, operationId: string): string[] {
  const before = specOperationFields(previous, operationId);
  const after = specOperationFields(next, operationId);
  const lines: string[] = [];

  if (before) {
    for (const [name, constraint] of before) {
      lines.push(...diffField(name, constraint, after?.get(name)));
    }
  }
  if (after) {
    for (const [name, constraint] of after) {
      if (!before?.has(name)) lines.push(...diffField(name, undefined, constraint));
    }
  }

  const beforeCodes = operationResponseCodes(previous, operationId);
  const afterCodes = operationResponseCodes(next, operationId);
  const newCodes = [...afterCodes].filter((code) => !beforeCodes.has(code)).sort();
  const goneCodes = [...beforeCodes].filter((code) => !afterCodes.has(code)).sort();
  if (newCodes.length) lines.push(`  - respuestas nuevas: ${newCodes.join(', ')}`);
  if (goneCodes.length) lines.push(`  - respuestas retiradas: ${goneCodes.join(', ')}`);

  const beforeSecurity = JSON.stringify(operationSecurity(previous, operationId));
  const afterSecurity = JSON.stringify(operationSecurity(next, operationId));
  if (beforeSecurity !== afterSecurity) {
    lines.push(`  - seguridad: ${beforeSecurity} → ${afterSecurity}`);
  }

  return lines;
}

export function buildSummary(previous: Json | undefined, next: Json): string {
  if (!previous) {
    return '## Resumen del contrato\n\nNo hay una versión anterior con la que comparar (primera sincronización).\n';
  }

  const beforeIds = allOperationIds(previous);
  const afterIds = allOperationIds(next);
  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const shared = [...afterIds].filter((id) => beforeIds.has(id)).sort();

  const sections: string[] = ['## Resumen del contrato', ''];

  const beforeVersion = (previous.info as Json | undefined)?.version;
  const afterVersion = (next.info as Json | undefined)?.version;
  if (beforeVersion || afterVersion) {
    sections.push(`De la versión \`${beforeVersion ?? '?'}\` a \`${afterVersion ?? '?'}\`.`, '');
  }

  sections.push('### Operaciones nuevas');
  sections.push(
    added.length
      ? added.map((id) => `- \`${id}\` (${operationLocation(next, id) ?? '?'})`).join('\n')
      : '- Ninguna.',
  );
  sections.push('', '### Operaciones retiradas');
  sections.push(
    removed.length
      ? removed.map((id) => `- \`${id}\` (${operationLocation(previous, id) ?? '?'})`).join('\n')
      : '- Ninguna.',
  );

  const changedBlocks: string[] = [];
  for (const operationId of shared) {
    const lines = diffOperation(previous, next, operationId);
    if (lines.length) {
      changedBlocks.push(`- \`${operationId}\` (${operationLocation(next, operationId) ?? '?'})`, ...lines);
    }
  }
  sections.push('', '### Cambios en operaciones existentes');
  sections.push(changedBlocks.length ? changedBlocks.join('\n') : '- Ninguno.');

  sections.push(
    '',
    '### Cobertura del catálogo MCP',
    'Operaciones nuevas o retiradas de la lista anterior necesitan un adaptador en `src/catalog.ts`, o retirar el' +
      ' que ya no aplique. `npm run check:surface` falla explícitamente si el catálogo y el contrato no' +
      ' coinciden operación por operación.',
  );

  return `${sections.join('\n')}\n`;
}

export function regenerateReadmeTable(): boolean {
  let output: string;
  try {
    output = execSync('npm run --silent measure:catalog', { cwd: root, encoding: 'utf8' });
  } catch (error) {
    process.stderr.write(`No fue posible regenerar la tabla de costo por perfil del README: ${error}\n`);
    return false;
  }

  const rows = output.split('\n').filter((line) => line.startsWith('| `'));
  if (rows.length === 0) return false;

  const readme = readFileSync(readmePath, 'utf8');
  const tableBlock =
    /(\| Perfil \| Herramientas \| Bytes de `tools\/list` \| Tokens estimados \|\n\|---\|---:\|---:\|---:\|\n)([\s\S]*?)(\n\n)/;
  if (!tableBlock.test(readme)) return false;

  const updated = readme.replace(tableBlock, (_match, header: string, _rows: string, tail: string) =>
    `${header}${rows.join('\n')}${tail}`,
  );
  if (updated === readme) return false;
  writeFileSync(readmePath, updated);
  return true;
}

function main(): void {
  const newSpecText = readFileSync(specPath, 'utf8');
  const newSha = sha256(newSpecText);
  updateExpectedSha(newSha);

  const previous = previousSpecDocument();
  const next = parseYaml(newSpecText) as Json;
  const summary = buildSummary(previous, next);

  const readmeChanged = regenerateReadmeTable();
  const summaryWithNote = readmeChanged
    ? `${summary}\n### Documentación\nSe regeneró la tabla de costo por perfil del README (\`npm run measure:catalog\`).\n`
    : summary;

  const summaryFile = process.env.VERIKO_SYNC_SUMMARY_FILE;
  if (summaryFile) {
    writeFileSync(summaryFile, summaryWithNote);
    process.stdout.write(`Resumen escrito en ${summaryFile}.\n`);
  } else {
    process.stdout.write(summaryWithNote);
  }
  process.stdout.write(`SHA-256 del contrato: ${newSha}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
