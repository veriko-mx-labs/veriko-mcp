import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NOT_EXPOSED_OPERATIONS, OPERATION_TOOLS } from '../src/catalog.js';
import { assertPublicM2MSurface } from './public-surface.js';
import { parse } from 'yaml';

const EXPECTED_PUBLIC_SPEC_SHA256 =
  '8f3a614dd4f35e53172d1e4017f3bc9080ee8aef6ebdf86b1373008523349077';
/**
 * The contract is read from the versioned copy, as in the other repositories of
 * the organization.
 *
 * The sync workflow brings it from the portal: it calls the organization's
 * reusable workflow, writes the public export here and opens a PR when it
 * changed. That PR is red on purpose, because this check compares against a
 * SHA-256 pinned by hand, and it is not auto-merged: a new contract is reviewed
 * operation by operation before it is accepted.
 *
 * Reading the portal on every run would make the result depend on whatever was
 * deployed at that moment, with nothing recorded in the repository.
 *
 * `VERIKO_OPENAPI_URL` still lets you point at a URL (the portal, a test
 * environment) to check by hand what is being served.
 */
const override = process.env.VERIKO_OPENAPI_URL;
const versionedCopy = new URL('../spec/openapi.yaml', import.meta.url);

let body: string;
if (override) {
  const response = await fetch(override, {
    cache: 'no-store',
    headers: { accept: 'application/yaml, text/yaml' },
  });
  if (!response.ok) {
    throw new Error(`Could not read ${override}: HTTP ${response.status}.`);
  }
  body = await response.text();
} else {
  body = readFileSync(versionedCopy, 'utf8');
}

const sha256 = createHash('sha256').update(body).digest('hex');
if (sha256 !== EXPECTED_PUBLIC_SPEC_SHA256) {
  throw new Error(
    `The public contract changed (${sha256}); review parameters, bodies, responses and security before updating EXPECTED_PUBLIC_SPEC_SHA256.`,
  );
}
/** Operations of the public M2M surface: 73 tools plus the two purge operations that are not exposed. */
const PUBLIC_OPERATIONS = 75;
assertPublicM2MSurface(
  parse(body),
  OPERATION_TOOLS.map((tool) => tool.operationId),
  PUBLIC_OPERATIONS,
  NOT_EXPOSED_OPERATIONS,
);

process.stdout.write(
  `MCP surface aligned: ${PUBLIC_OPERATIONS} operations, ${OPERATION_TOOLS.length} with a tool.\n`,
);
