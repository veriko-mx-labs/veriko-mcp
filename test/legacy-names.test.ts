import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { FAMILIES, type Profile } from '../src/config.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { ALL, clientFor, connect, startFakeApi, type Connected } from './support.js';

/** Los nombres de campo anteriores. No aparecen como identificadores en nada de lo que el servidor muestra ni documenta. */
const FORMER_NAMES = [
  'fecha',
  'monto',
  'claveRastreo',
  'clave_rastreo',
  'referenciaNumerica',
  'referencia_numerica',
  'emisor',
  'receptor',
  'cuentaBeneficiaria',
  'cuenta_beneficiaria',
  'cuentasCandidatas',
  'cuentas_candidatas',
  'receptorParticipante',
  'receptor_participante',
  'bancoEmisor',
  'banco_emisor',
  'bancoReceptor',
  'banco_receptor',
  'idValidacion',
  'id_validacion',
];
const FORMER = new Set(FORMER_NAMES.map((name) => name.toLowerCase()));

/** Los identificadores de un texto: lo que va entre comillas invertidas y los bloques de código. La prosa queda fuera. */
function codeIn(text: string): string[] {
  const blocks = [...text.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
  const spans = [...text.replaceAll(/```[\s\S]*?```/g, ' ').matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
  return [...blocks, ...spans];
}

function formerIn(code: string): string | undefined {
  return (code.match(/[A-Za-z_]+/g) ?? []).find((token) => FORMER.has(token.toLowerCase()));
}

/** Recorre un valor JSON: las claves, los valores que son un nombre solo y el código de cada texto. */
function walk(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'string') {
    if (FORMER.has(value.toLowerCase())) found.push(`${path} = "${value}"`);
    for (const code of codeIn(value)) {
      const token = formerIn(code);
      if (token) found.push(`${path} contiene \`${token}\` como código`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORMER.has(key.toLowerCase())) found.push(`${path}.${key} (clave)`);
      walk(item, `${path}.${key}`, found);
    }
  }
}

function assertClean(label: string, value: unknown): void {
  const found: string[] = [];
  walk(value, label, found);
  assert.deepEqual(found, [], `${label} usa un nombre anterior como identificador`);
}

function assertCodeClean(label: string, text: string): void {
  const found: string[] = [];
  for (const code of codeIn(text)) {
    const token = formerIn(code);
    if (token) found.push(token);
  }
  assert.deepEqual(found, [], `${label} usa un nombre anterior como identificador`);
}

const open: Connected[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('nombres de campo anteriores', () => {
  for (const profile of ['core', ...FAMILIES, 'all']) {
    it(`no aparecen en tools/list del perfil ${profile}`, async () => {
      const connected = await connect({
        config: {
          apiKey: '',
          profiles: new Set<Profile>([profile as Profile]),
          maxRisk: 'destructive',
          fileRoots: ['/tmp'],
        },
      });
      open.push(connected);
      assertClean(`tools/list (${profile})`, (await connected.client.listTools()).tools);
    });
  }

  it('no aparecen en recursos, prompts ni instrucciones del servidor', async () => {
    const api = await startFakeApi();
    try {
      const connected = await connect({ config: ALL, client: clientFor(api) });
      open.push(connected);
      const { client } = connected;
      assertClean('resources', await client.listResources());
      assertClean('resource templates', await client.listResourceTemplates());
      const prompts = await client.listPrompts();
      assertClean('prompts/list', prompts);
      for (const prompt of prompts.prompts) {
        const result = await client.getPrompt({
          name: prompt.name,
          arguments: { details: 'x', month: '2026-09', url: 'https://example.com/h' },
        });
        assertClean(`prompt ${prompt.name}`, result);
      }
      assertClean('instructions', SERVER_INSTRUCTIONS);
      assertClean('docs resource', await client.readResource({ uri: 'veriko://docs' }));
    } finally {
      await api.close();
    }
  });

  it('no aparecen como código en el README, el CHANGELOG ni SECURITY', () => {
    for (const file of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) {
      assertCodeClean(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
  });
  it('detecta un alias que se cuela como campo, como parámetro o como código, y deja pasar la prosa', () => {
    const found = (value: unknown) => {
      const result: string[] = [];
      walk(value, 'x', result);
      return result;
    };
    assert.notEqual(found({ properties: { monto: { type: 'number' } } }).length, 0);
    assert.notEqual(found({ required: ['clave_rastreo'] }).length, 0);
    assert.notEqual(found({ description: 'Envía `fecha` y `amount`.' }).length, 0);
    assert.notEqual(found({ description: 'Ejemplo: ```json\n{ "claveRastreo": "A1" }\n```' }).length, 0);
    assert.deepEqual(found({ description: 'La fecha y el monto del emisor, con la clave de rastreo.' }), []);
    assert.deepEqual(found({ properties: { amount: {}, send_date: {} } }), []);
  });
});

/** Calls a tool with the current names and then with the former ones; both requests must match. */
async function sameRequest(name: string, current: Record<string, unknown>, former: Record<string, unknown>) {
  const api = await startFakeApi();
  try {
    const connected = await connect({ config: ALL, client: clientFor(api) });
    open.push(connected);
    const first = await connected.client.callTool({ name, arguments: current });
    const second = await connected.client.callTool({ name, arguments: former });
    assert.notEqual(second.isError, true, `${name} rejected the former names: ${JSON.stringify(second.content)}`);
    assert.equal(first.isError, second.isError);
    const [a, b] = api.seen;
    assert.ok(a && b, `${name} did not reach the API twice`);
    assert.equal(b.method, a.method);
    assert.equal(b.url, a.url);
    assert.equal(b.body, a.body);
  } finally {
    await api.close();
  }
}

describe('former field names in a call', () => {
  const VALIDATION = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const ENDPOINT = '0b6f3c2e-1d4a-4f5b-9c8d-7e6f5a4b3c2d';

  it('reach the API as the current names in a direct validation', async () => {
    await sameRequest(
      'veriko_validate_direct',
      {
        amount: 100,
        tracking_key: 'ABC-123',
        beneficiary_account: '012180004412345678',
        send_date: '2026-11-13',
        recipient_is_bank: true,
        client_ref: 'order-1',
        idempotency_key: 'same-key',
      },
      {
        monto: 100,
        claveRastreo: 'ABC-123',
        cuentaBeneficiaria: '012180004412345678',
        fecha: '2026-11-13',
        receptorParticipante: 1,
        clientRef: 'order-1',
        idempotencyKey: 'same-key',
      },
    );
  });

  it('reach the API as the current names in list filters', async () => {
    await sameRequest(
      'veriko_list_validations',
      { with_deleted: 1, per_page: 5, client_ref: 'order-1' },
      { withDeleted: true, perPage: 5, clientRef: 'order-1' },
    );
    await sameRequest(
      'veriko_list_all_deliveries',
      { endpoint_id: [ENDPOINT], validation_id: VALIDATION },
      { endpointIds: [ENDPOINT], validationId: VALIDATION },
    );
  });

  it('reach the API as the current names in a path parameter', async () => {
    await sameRequest('veriko_get_validation', { validation_id: VALIDATION }, { validationId: VALIDATION });
  });

  it('lose to the current name when both are sent', async () => {
    await sameRequest('veriko_list_validations', { per_page: 5 }, { per_page: 5, perPage: 50 });
  });

  it('stay rejected when they were withdrawn on purpose', async () => {
    const api = await startFakeApi();
    try {
      const connected = await connect({ config: ALL, client: clientFor(api) });
      open.push(connected);
      const result = await connected.client.callTool({ name: 'veriko_list_validations', arguments: { userId: 7 } });
      assert.equal(result.isError, true);
      assert.equal(api.seen.length, 0);
    } finally {
      await api.close();
    }
  });
});
