/**
 * Mide lo que cuesta anunciar cada perfil.
 *
 * La cifra sale del servidor real por stdio, no de una reconstrucción
 * del catálogo: `tools/list` es exactamente lo que el cliente inyecta en el
 * contexto del modelo, con el JSON Schema que el SDK deriva de Zod.
 *
 * Los tokens son una estimación declarada, no una medición: no se usa
 * ningún tokenizador de un proveedor. La razón de bytes por token es fija en 3.6;
 * sirve para comparar perfiles entre sí, no para presupuestar un cliente concreto.
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
  process.stderr.write(`medido ${profile}\n`);
}

process.stdout.write(
  [
    `Medido con ${process.version}, con riesgo \`destructive\` para que no se oculte ninguna herramienta.`,
    `Tokens estimados a ${BYTES_PER_TOKEN} bytes por token; no es una tokenización real.`,
    '',
    '| Perfil | Herramientas | Bytes de `tools/list` | Tokens estimados |',
    '|---|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n'),
);
