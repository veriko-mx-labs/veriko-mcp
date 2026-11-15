import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { serverInstructions, withoutMissingTools } from '../src/server.js';
import { ALL, connect, type Connected } from './support.js';

const open: Connected[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

async function session(client: Veriko) {
  const connected = await connect({ config: { ...ALL, profiles: new Set(['core' as const]) }, client });
  open.push(connected);
  return connected;
}

describe('arreglos de la prueba del servidor remoto', () => {
  it('quita las frases que nombran herramientas que no se ofrecen', () => {
    const text = 'Usa veriko_get_validation. Luego veriko_delete_validation si quieres.\n\nSólo texto.';
    assert.equal(withoutMissingTools(text, new Set(['veriko_get_validation'])), 'Usa veriko_get_validation.\n\nSólo texto.');
    assert.equal(withoutMissingTools('Llama a veriko_recheck_validation.', new Set()), '');
  });

  it('las instrucciones del perfil core no nombran herramientas fuera de él', async () => {
    const { client } = await session({} as Veriko);
    const offered = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const instructions = client.getInstructions() ?? '';
    for (const name of instructions.match(/veriko_[a-z_]+/g) ?? []) assert.ok(offered.has(name), name);
    assert.ok(!serverInstructions(true, offered).includes('veriko://artifact/'));
  });

  it('veriko_get_usage_limits trae la cuota y los límites de peticiones', async () => {
    const fake = {
      usage: {
        summary: async () => ({ type: 'usage_summary', attributes: { limit: 650, used: 3, remaining: 647 } }),
        limits: async () => ({ type: 'usage_limits', attributes: { rate_limits: { per_minute: 240, credential_per_minute: 120 } } }),
      },
    } as unknown as Veriko;
    const { client } = await session(fake);
    const result = await client.callTool({ name: 'veriko_get_usage_limits', arguments: {} });
    assert.deepEqual(result.structuredContent, {
      quota: { limit: 650, used: 3, remaining: 647 },
      rate_limits: { per_minute: 240, credential_per_minute: 120 },
    });
  });

  it('devuelve llaves en snake_case y sin la cadena ni la firma del CEP', async () => {
    const fake = {
      validations: {
        get: async () => ({
          data: { id: 'v1', attributes: { banxico_result: { estado: 'L', cadenaCda: 'x', digitalSignature: 'y' } } },
          etag: 'W/"1"',
          idempotentReplayed: false,
        }),
      },
    } as unknown as Veriko;
    const { client } = await session(fake);
    const result = await client.callTool({ name: 'veriko_get_validation', arguments: { validation_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' } });
    const content = result.structuredContent as Record<string, unknown>;
    assert.ok(!('idempotentReplayed' in content));
    const serialized = JSON.stringify(content);
    assert.ok(!serialized.includes('cadenaCda') && !serialized.includes('digitalSignature'), serialized);
    assert.ok(serialized.includes('"estado":"L"'));
  });
});
