import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

it('negocia el protocolo MCP vigente sobre stdio real', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: root,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      VERIKO_MCP_PROFILE: 'plans',
      VERIKO_MCP_MAX_RISK: 'read',
    },
  });
  const client = new Client({ name: 'veriko-stdio-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['veriko_get_public_plan_comparison', 'veriko_list_public_plans'],
    );
  } finally {
    await client.close();
  }
});

it(
  'acepta por stdio una importación válida de 20 MB',
  { timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: root,
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        VERIKO_API_KEY: '',
        VERIKO_MCP_PROFILE: 'beneficiaries',
        VERIKO_MCP_MAX_RISK: 'write',
      },
    });
    const client = new Client({ name: 'veriko-stdio-large-input-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'veriko_create_beneficiary_import',
        arguments: {
          fileBase64: Buffer.alloc(20 * 1024 * 1024).toString('base64'),
          filename: 'beneficiarios.csv',
        },
      });
      assert.equal(result.isError, true);
      assert.equal(
        (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code,
        'configuration_error',
      );
    } finally {
      await client.close();
    }
  },
);
