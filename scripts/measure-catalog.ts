/**
 * Measures what it costs to announce each profile.
 *
 * The figure comes from the real server over stdio, not from a reconstruction
 * of the catalog: `tools/list` is exactly what the client injects into the
 * model context, with the JSON Schema the SDK derives from Zod.
 *
 * Tokens are a declared estimate, not a measurement: no provider tokenizer is
 * used. The bytes-per-token ratio is fixed at 3.6; it serves to compare
 * profiles with one another, not to budget a specific client.
 */
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { FAMILIES } from '../src/config.js';

const BYTES_PER_TOKEN = 3.6;
const root = fileURLToPath(new URL('..', import.meta.url));

async function measure(profile: string): Promise<{ tools: number; bytes: number }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: root,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      VERIKO_API_KEY: '',
      VERIKO_MCP_PROFILE: profile,
      VERIKO_MCP_MAX_RISK: 'destructive',
    },
  });
  const client = new Client({ name: 'veriko-catalog-measure', version: '1.0.0' });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      tools: tools.length,
      bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    };
  } finally {
    await client.close();
  }
}

const profiles = ['core', ...FAMILIES, 'all'];
const rows: string[] = [];

for (const profile of profiles) {
  const { tools, bytes } = await measure(profile);
  const tokens = Math.round(bytes / BYTES_PER_TOKEN);
  rows.push(
    `| \`${profile}\` | ${tools} | ${bytes.toLocaleString('en-US')} | ~${tokens.toLocaleString('en-US')} |`,
  );
  process.stderr.write(`measured ${profile}\n`);
}

process.stdout.write(
  [
    `Measured with ${process.version}, risk \`destructive\` so that no tool is hidden.`,
    `Tokens estimated at ${BYTES_PER_TOKEN} bytes per token; this is not a real tokenization.`,
    '',
    '| Profile | Tools | Bytes of `tools/list` | Estimated tokens |',
    '|---|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n'),
);
