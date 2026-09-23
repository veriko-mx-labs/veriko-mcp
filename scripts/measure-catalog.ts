/**
 * Mide lo que cuesta anunciar cada perfil.
 *
 * La cifra sale del servidor real por stdio, no de una reconstrucción del
 * catálogo: `tools/list` es exactamente lo que el cliente inyecta en el
 * contexto del modelo, ya con el JSON Schema que el SDK deriva de Zod.
 *
 * Los tokens son una estimación declarada, no una medición: no se tokeniza
 * con el tokenizador de ningún proveedor. La razón bytes/token se fija en
 * 3.6, la que da el español con identificadores en inglés; sirve para
 * comparar perfiles entre sí, no para presupuestar un cliente concreto.
 */
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { FAMILIES } from '../src/config.js';

const BYTES_POR_TOKEN = 3.6;
const root = fileURLToPath(new URL('..', import.meta.url));

async function medir(profile: string): Promise<{ herramientas: number; bytes: number }> {
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
      herramientas: tools.length,
      bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    };
  } finally {
    await client.close();
  }
}

const perfiles = ['core', ...FAMILIES, 'all'];
const filas: string[] = [];

for (const perfil of perfiles) {
  const { herramientas, bytes } = await medir(perfil);
  const tokens = Math.round(bytes / BYTES_POR_TOKEN);
  filas.push(
    `| \`${perfil}\` | ${herramientas} | ${bytes.toLocaleString('en-US')} | ~${tokens.toLocaleString('en-US')} |`,
  );
  process.stderr.write(`medido ${perfil}\n`);
}

process.stdout.write(
  [
    `Medido con ${process.version}, riesgo \`destructive\` para no ocultar herramientas.`,
    `Tokens estimados a ${BYTES_POR_TOKEN} bytes por token; no es una tokenización real.`,
    '',
    '| Perfil | Herramientas | Bytes de `tools/list` | Tokens estimados |',
    '|---|---:|---:|---:|',
    ...filas,
    '',
  ].join('\n'),
);
