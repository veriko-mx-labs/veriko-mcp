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
