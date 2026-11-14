#!/usr/bin/env node

import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createVerikoServer } from './server.js';

serveStdio(() => createVerikoServer(), {
  transport: new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 32 * 1024 * 1024,
  }),
  onerror(error) {
    process.stderr.write(`Error de transporte en veriko-mcp: ${error.message}\n`);
  },
});

export { createVerikoServer } from './server.js';
