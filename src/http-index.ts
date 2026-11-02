#!/usr/bin/env node

import { createHttpApp, startHttpServer } from './http.js';

function integerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

const port = integerFromEnv('VERIKO_MCP_HTTP_PORT', 3000, 1, 65535);
const host = process.env.VERIKO_MCP_HTTP_HOST?.trim() || '127.0.0.1';
const allowedOrigins = (process.env.VERIKO_MCP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const app = createHttpApp({
  path: process.env.VERIKO_MCP_HTTP_PATH?.trim() || '/mcp',
  allowedOrigins,
  ...(process.env.VERIKO_MCP_HTTP_MAX_BODY_BYTES
    ? { maxBodyBytes: integerFromEnv('VERIKO_MCP_HTTP_MAX_BODY_BYTES', 0, 1024, 256 * 1024 * 1024) }
    : {}),
  ...(process.env.VERIKO_MCP_HTTP_MAX_INLINE_BYTES
    ? {
        maxInlineArtifactBytes: integerFromEnv(
          'VERIKO_MCP_HTTP_MAX_INLINE_BYTES',
          0,
          1024,
          64 * 1024 * 1024,
        ),
      }
    : {}),
  onerror(error) {
    process.stderr.write(`Error HTTP en veriko-mcp: ${error.message}\n`);
  },
});

const server = await startHttpServer(app, { port, host });
process.stderr.write(`veriko-mcp escuchando en http://${host}:${port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void app.close().finally(() => process.exit(0));
  });
}
