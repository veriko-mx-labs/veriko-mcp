import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Veriko } from '@veriko-mx/sdk-runtime';

import { createVerikoServer } from '../src/server.js';

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe('servidor MCP', () => {
  it('anuncia sólo el perfil solicitado y ejecuta una operación pública', async () => {
    const fake = {
      plans: {
        listPublic: async () => ({ data: [{ id: 'integrador' }] }),
        getPublicPlanComparison: async () => ({ data: [] }),
      },
    } as unknown as Veriko;
    const server = createVerikoServer({
      client: fake,
      config: {
        apiKey: '',
        profiles: new Set(['plans']),
        maxRisk: 'read',
      },
    });
    const client = new Client({ name: 'veriko-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['veriko_get_public_plan_comparison', 'veriko_list_public_plans'],
    );

    const result = await client.callTool({
      name: 'veriko_list_public_plans',
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { data: [{ id: 'integrador' }] });
  });
});
