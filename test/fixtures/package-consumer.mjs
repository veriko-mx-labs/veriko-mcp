import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createVerikoServer } from '@veriko-mx/mcp';

if (typeof createVerikoServer !== 'function') {
  throw new Error('El paquete no exporta createVerikoServer.');
}

const entry = fileURLToPath(
  new URL('./node_modules/@veriko-mx/mcp/dist/index.js', import.meta.url),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    ...getDefaultEnvironment(),
    VERIKO_MCP_PROFILE: 'plans',
    VERIKO_MCP_MAX_RISK: 'read',
  },
});
const client = new Client({ name: 'veriko-package-consumer', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = ['veriko_get_public_plan_comparison', 'veriko_list_public_plans'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Herramientas inesperadas: ${names.join(', ')}`);
  }
} finally {
  await client.close();
}
