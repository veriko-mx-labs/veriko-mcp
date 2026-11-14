import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { FAMILIES, type Profile } from '../src/config.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { ALL, clientFor, connect, startFakeApi, type Connected } from './support.js';

/** The former field names. They stay out of everything the server shows and documents. */
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
const PATTERN = new RegExp(`(?<![A-Za-z])(${FORMER_NAMES.join('|')})(?![A-Za-z])`, 'i');

function assertClean(label: string, text: string): void {
  const found = PATTERN.exec(text);
  assert.equal(found, null, `${label} contains the former name "${found?.[0]}"`);
}

const open: Connected[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('former field names', () => {
  for (const profile of ['core', ...FAMILIES, 'all']) {
    it(`do not appear in tools/list of the ${profile} profile`, async () => {
      const connected = await connect({
        config: {
          apiKey: '',
          profiles: new Set<Profile>([profile as Profile]),
          maxRisk: 'destructive',
          fileRoots: ['/tmp'],
        },
      });
      open.push(connected);
      assertClean(`tools/list (${profile})`, JSON.stringify((await connected.client.listTools()).tools));
    });
  }

  it('do not appear in resources, prompts or the server instructions', async () => {
    const api = await startFakeApi();
    try {
      const connected = await connect({ config: ALL, client: clientFor(api) });
      open.push(connected);
      const { client } = connected;
      assertClean('resources', JSON.stringify(await client.listResources()));
      assertClean('resource templates', JSON.stringify(await client.listResourceTemplates()));
      const prompts = await client.listPrompts();
      assertClean('prompts/list', JSON.stringify(prompts));
      for (const prompt of prompts.prompts) {
        const result = await client.getPrompt({
          name: prompt.name,
          arguments: { details: 'x', month: '2026-09', url: 'https://example.com/h' },
        });
        assertClean(`prompt ${prompt.name}`, JSON.stringify(result));
      }
      assertClean('instructions', SERVER_INSTRUCTIONS);
      assertClean('docs resource', JSON.stringify(await client.readResource({ uri: 'veriko://docs' })));
    } finally {
      await api.close();
    }
  });

  it('do not appear in the README, the CHANGELOG or SECURITY', () => {
    for (const file of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) {
      assertClean(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
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
