import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { connect } from './support.js';
import { FAMILIES, type Profile } from '../src/config.js';

/**
 * Ceilings, in bytes, for `tools/list` of each profile at risk `destructive`:
 * what a client injects into the model context. A change that raises one goes
 * through this file, so growth is a decision and not a side effect. Measure
 * with `npm run measure:catalog`; tokens are about bytes / 3.6.
 */
const BUDGET_BYTES: Readonly<Record<string, { tools: number; bytes: number }>> = {
  core: { tools: 8, bytes: 26_000 },
  validations: { tools: 15, bytes: 44_000 },
  webhooks: { tools: 10, bytes: 29_500 },
  catalog: { tools: 5, bytes: 6_700 },
  beneficiaries: { tools: 16, bytes: 26_800 },
  usage: { tools: 7, bytes: 8_900 },
  account: { tools: 3, bytes: 4_800 },
  dashboard: { tools: 1, bytes: 1_300 },
  plans: { tools: 2, bytes: 2_200 },
  insights: { tools: 4, bytes: 5_000 },
  finance: { tools: 12, bytes: 20_600 },
  billing: { tools: 1, bytes: 1_100 },
  all: { tools: 76, bytes: 150_500 },
};

/** A ceiling more than this far above the real size stops guarding anything. */
const MAX_SLACK = 0.08;

describe('tools/list size', () => {
  for (const profile of ['core', ...FAMILIES, 'all']) {
    it(`keeps the ${profile} profile within its budget`, async () => {
      const budget = BUDGET_BYTES[profile];
      assert.ok(budget, `no budget for ${profile}`);
      const { client, close } = await connect({
        config: { apiKey: '', profiles: new Set<Profile>([profile as Profile]), maxRisk: 'destructive' },
      });
      try {
        const { tools } = await client.listTools();
        const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
        assert.equal(tools.length, budget.tools, `the ${profile} profile announces ${tools.length} tools`);
        assert.ok(bytes <= budget.bytes, `${profile}: ${bytes} bytes exceed the ${budget.bytes} budget`);
        assert.ok(
          bytes >= budget.bytes * (1 - MAX_SLACK),
          `${profile}: ${bytes} bytes are far below the ${budget.bytes} budget; lower the budget`,
        );
      } finally {
        await close();
      }
    });
  }
});
