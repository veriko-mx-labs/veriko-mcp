#!/usr/bin/env node

import { createHttpApp, startHttpServer } from './http.js';

function integerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const port = integerFromEnv('VERIKO_MCP_HTTP_PORT', 3000, 1, 65535);
const host = process.env.VERIKO_MCP_HTTP_HOST?.trim() || '127.0.0.1';
function listFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const allowedOrigins = listFromEnv('VERIKO_MCP_ALLOWED_ORIGINS');
const allowedHosts = listFromEnv('VERIKO_MCP_ALLOWED_HOSTS');
if (allowedHosts.length === 0 && !LOOPBACK.has(host)) {
  throw new Error(
    'VERIKO_MCP_ALLOWED_HOSTS is required when the server listens outside 127.0.0.1: ' +
      'set the public host names, separated by commas.',
  );
}

const app = createHttpApp({
  path: process.env.VERIKO_MCP_HTTP_PATH?.trim() || '/mcp',
  allowedOrigins,
  ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
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
    process.stderr.write(`HTTP error in veriko-mcp: ${error.message}\n`);
  },
});

const server = await startHttpServer(app, { port, host });
process.stderr.write(`veriko-mcp listening on http://${host}:${port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void app.close().finally(() => process.exit(0));
  });
}
