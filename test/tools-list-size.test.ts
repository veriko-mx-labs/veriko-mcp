import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { connect } from './support.js';
import { FAMILIES, type Profile } from '../src/config.js';

/**
 * Techos, en bytes, de `tools/list` de cada perfil con riesgo `destructive`:
 * lo que un cliente inyecta en el contexto del modelo. Un cambio que sube uno
 * pasa por este archivo, así que el crecimiento es una decisión y no un efecto
 * colateral.
 *
 * Mide con `npm run measure:catalog`; los tokens son cerca de bytes / 3.6.
 */
const BUDGET_BYTES: Readonly<Record<string, { tools: number; bytes: number }>> = {
  core: { tools: 8, bytes: 27_300 },
  validations: { tools: 15, bytes: 45_900 },
  webhooks: { tools: 10, bytes: 30_300 },
  catalog: { tools: 5, bytes: 7_000 },
  beneficiaries: { tools: 16, bytes: 28_100 },
  usage: { tools: 7, bytes: 9_200 },
  account: { tools: 3, bytes: 5_000 },
  dashboard: { tools: 1, bytes: 1_300 },
  plans: { tools: 2, bytes: 2_250 },
  insights: { tools: 4, bytes: 5_150 },
  finance: { tools: 12, bytes: 21_500 },
  billing: { tools: 1, bytes: 1_100 },
  all: { tools: 76, bytes: 156_500 },
};

/** Un techo más alejado que esto del tamaño real ya no protege nada. */
const MAX_SLACK = 0.08;

describe('tamaño de tools/list', () => {
  for (const profile of ['core', ...FAMILIES, 'all']) {
    it(`mantiene el perfil ${profile} dentro de su presupuesto`, async () => {
      const budget = BUDGET_BYTES[profile];
      assert.ok(budget, `no hay presupuesto para ${profile}`);
      const { client, close } = await connect({
        config: { apiKey: '', profiles: new Set<Profile>([profile as Profile]), maxRisk: 'destructive' },
      });
      try {
        const { tools } = await client.listTools();
        const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
        assert.equal(tools.length, budget.tools, `el perfil ${profile} anuncia ${tools.length} herramientas`);
        assert.ok(bytes <= budget.bytes, `${profile}: ${bytes} bytes superan el presupuesto de ${budget.bytes}`);
        assert.ok(
          bytes >= budget.bytes * (1 - MAX_SLACK),
          `${profile}: ${bytes} bytes están muy por debajo del presupuesto de ${budget.bytes}; bájalo`,
        );
      } finally {
        await close();
      }
    });
  }
});
