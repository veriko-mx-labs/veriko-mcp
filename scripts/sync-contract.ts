/**
 * Regeneration command that `sync-public-spec.yml` runs after the
 * organization's reusable workflow writes the new spec to `spec/openapi.yaml`,
 * before the PR is opened or updated.
 *
 * It does three things:
 *
 * 1. Recomputes the SHA-256 of the contract and pins it in
 *    `EXPECTED_PUBLIC_SPEC_SHA256` (`scripts/check-public-surface.ts`), so that
 *    lock validates the new contract instead of stopping the run before there
 *    is a PR to review.
 * 2. Compares the previous contract (the one on `main`, through
 *    `git show HEAD:spec/openapi.yaml`) with the new one and writes a Markdown
 *    summary, operation by operation, to `VERIKO_SYNC_SUMMARY_FILE` if the
 *    variable is set (otherwise to stdout).
 * 3. Regenerates the cost-per-profile table of the README (`npm run
 *    measure:catalog`).
 *
 * It validates nothing: `npm test` (including the limits lock) and
 * `npm run check:surface` already do that as part of the PR CI. If this
 * regeneration failed under `set -e`, the PR would never open, which is the
 * original problem this script fixes.
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
    throw new Error('Could not find the EXPECTED_PUBLIC_SPEC_SHA256 declaration.');
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
  const bits: string[] = [constraint.required ? 'required' : 'optional'];
  if (constraint.type) bits.push(constraint.type);
  if (constraint.enum) bits.push(`enum ${JSON.stringify(constraint.enum)}`);
  if (constraint.maxLength !== undefined) bits.push(`maxLength ${constraint.maxLength}`);
  if (constraint.minLength !== undefined) bits.push(`minLength ${constraint.minLength}`);
  if (constraint.maximum !== undefined) bits.push(`maximum ${constraint.maximum}`);
  if (constraint.minimum !== undefined) bits.push(`minimum ${constraint.minimum}`);
  return bits.join(', ');
}

/** Diffs two versions of the same field (previous spec against new spec), not spec against Zod. */
export function diffField(name: string, before: FieldConstraint | undefined, after: FieldConstraint | undefined): string[] {
  if (!before && after) return [`  - new field \`${name}\`: ${describeFieldConstraint(after)}`];
  if (before && !after) return [`  - field removed \`${name}\``];
  if (!before || !after) return [];

  const changes: string[] = [];
  if (before.required !== after.required) {
    changes.push(after.required ? 'now required' : 'now optional');
  }
  if (before.type !== after.type) changes.push(`tipo ${before.type ?? '?'} → ${after.type ?? '?'}`);
  if (before.maxLength !== after.maxLength) {
    changes.push(`maxLength ${before.maxLength ?? 'no limit'} → ${after.maxLength ?? 'no limit'}`);
  }
  if (before.minLength !== after.minLength) {
    changes.push(`minLength ${before.minLength ?? 'no minimum'} → ${after.minLength ?? 'no minimum'}`);
  }
  if (before.maximum !== after.maximum) {
    changes.push(`maximum ${before.maximum ?? 'no limit'} → ${after.maximum ?? 'no limit'}`);
  }
  if (before.minimum !== after.minimum) {
    changes.push(`minimum ${before.minimum ?? 'no minimum'} → ${after.minimum ?? 'no minimum'}`);
  }
  if (JSON.stringify(before.enum) !== JSON.stringify(after.enum)) {
    changes.push(`enum ${JSON.stringify(before.enum ?? [])} → ${JSON.stringify(after.enum ?? [])}`);
  }
  if ((before.pattern ?? null) !== (after.pattern ?? null)) {
    changes.push('validation pattern changed');
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
  if (newCodes.length) lines.push(`  - new responses: ${newCodes.join(', ')}`);
  if (goneCodes.length) lines.push(`  - removed responses: ${goneCodes.join(', ')}`);

  const beforeSecurity = JSON.stringify(operationSecurity(previous, operationId));
  const afterSecurity = JSON.stringify(operationSecurity(next, operationId));
  if (beforeSecurity !== afterSecurity) {
    lines.push(`  - security: ${beforeSecurity} → ${afterSecurity}`);
  }

  return lines;
}

export function buildSummary(previous: Json | undefined, next: Json): string {
  if (!previous) {
    return '## Contract summary\n\nThere is no previous version to compare with (first sync).\n';
  }

  const beforeIds = allOperationIds(previous);
  const afterIds = allOperationIds(next);
  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const shared = [...afterIds].filter((id) => beforeIds.has(id)).sort();

  const sections: string[] = ['## Contract summary', ''];

  const beforeVersion = (previous.info as Json | undefined)?.version;
  const afterVersion = (next.info as Json | undefined)?.version;
  if (beforeVersion || afterVersion) {
    sections.push(`From version \`${beforeVersion ?? '?'}\` to \`${afterVersion ?? '?'}\`.`, '');
  }

  sections.push('### New operations');
  sections.push(
    added.length
      ? added.map((id) => `- \`${id}\` (${operationLocation(next, id) ?? '?'})`).join('\n')
      : '- None.',
  );
  sections.push('', '### Removed operations');
  sections.push(
    removed.length
      ? removed.map((id) => `- \`${id}\` (${operationLocation(previous, id) ?? '?'})`).join('\n')
      : '- None.',
  );

  const changedBlocks: string[] = [];
  for (const operationId of shared) {
    const lines = diffOperation(previous, next, operationId);
    if (lines.length) {
      changedBlocks.push(`- \`${operationId}\` (${operationLocation(next, operationId) ?? '?'})`, ...lines);
    }
  }
  sections.push('', '### Changes to existing operations');
  sections.push(changedBlocks.length ? changedBlocks.join('\n') : '- None.');

  sections.push(
    '',
    '### MCP catalog coverage',
    'New operations need an adapter in `src/catalog.ts`, and removed ones need theirs deleted.' +
      ' `npm run check:surface` fails explicitly when the catalog and the contract do not' +
      ' match operation by operation.',
  );

  return `${sections.join('\n')}\n`;
}

export function regenerateReadmeTable(): boolean {
  let output: string;
  try {
    output = execSync('npm run --silent measure:catalog', { cwd: root, encoding: 'utf8' });
  } catch (error) {
    process.stderr.write(`Could not regenerate the cost-per-profile table of the README: ${error}\n`);
    return false;
  }

  const rows = output.split('\n').filter((line) => line.startsWith('| `'));
  if (rows.length === 0) return false;

  const readme = readFileSync(readmePath, 'utf8');
  const tableBlock =
    /(\| Profile \| Tools \| Bytes of `tools\/list` \| Estimated tokens \|\n\|---\|---:\|---:\|---:\|\n)([\s\S]*?)(\n\n)/;
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
    ? `${summary}\n### Documentation\nThe cost-per-profile table of the README was regenerated (\`npm run measure:catalog\`).\n`
    : summary;

  const summaryFile = process.env.VERIKO_SYNC_SUMMARY_FILE;
  if (summaryFile) {
    writeFileSync(summaryFile, summaryWithNote);
    process.stdout.write(`Summary written to ${summaryFile}.\n`);
  } else {
    process.stdout.write(summaryWithNote);
  }
  process.stdout.write(`Contract SHA-256: ${newSha}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
