/**
 * Warns when the SDK the MCP consumes has fallen behind.
 *
 * The sync chain is spec, then SDK, then MCP: the organization's reusable
 * workflow regenerates the SDK when the portal publishes a new contract. The MCP
 * pins the SDK by version and integrity, so a new SDK version does not arrive on
 * its own: someone has to move it.
 *
 * `check:surface` does not cover that step. It detects that the contract
 * changed, not that the SDK that implements it arrived. A whole version can pass
 * between the two with nothing saying so.
 *
 * This updates nothing by itself: it reports. Raising the SDK changes the
 * lockfile and the publishable artifact, and that is reviewed in a PR.
 */
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/@veriko-mx%2Fsdk';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

const pinnedSpec = packageJson.dependencies?.['@veriko-mx/sdk-runtime'];
if (!pinnedSpec) {
  throw new Error('package.json has no `@veriko-mx/sdk-runtime` dependency.');
}

const pinned = /^npm:@veriko-mx\/sdk@(\d+\.\d+\.\d+)$/.exec(pinnedSpec)?.[1];
if (!pinned) {
  throw new Error(
    `The SDK source is no longer an exact npm version (${pinnedSpec}); ` +
      'check by hand that it is still immutable before changing this lock.',
  );
}

// The registry is public and needs no credential, so this no longer depends on
// a token or on the GitHub API quota.
const response = await fetch(REGISTRY, {
  cache: 'no-store',
  headers: { accept: 'application/json' },
});
if (!response.ok) {
  throw new Error(`Could not read @veriko-mx/sdk on npm: HTTP ${response.status}.`);
}

const document = (await response.json()) as { 'dist-tags'?: Record<string, string> };
const published = document['dist-tags']?.latest ?? '';
if (!/^\d+\.\d+\.\d+$/.test(published)) {
  throw new Error(`@veriko-mx/sdk has no readable \`latest\` (${published}).`);
}

if (published !== pinned) {
  throw new Error(
    `The SDK moved to ${published} and the MCP is still on ${pinned}.\n` +
      'To catch up:\n' +
      `  1. set \`@veriko-mx/sdk-runtime\` to \`npm:@veriko-mx/sdk@${published}\` in package.json;\n` +
      '  2. run `npm install` to pin the integrity in the lockfile again;\n' +
      '  3. run `npm run check` and `npm run check:surface`, which says whether the surface changed;\n' +
      '  4. open the PR: raising the SDK changes the publishable artifact.',
  );
}

process.stdout.write(`SDK up to date: the MCP consumes ${pinned}, the latest published on npm.\n`);
