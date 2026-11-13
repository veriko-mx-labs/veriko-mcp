import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runOracle } from '../evals/runner.js';
import { SCENARIOS } from '../evals/scenarios.js';

describe('evals', () => {
  it('every scenario is still measurable', { timeout: 60_000 }, async () => {
    assert.equal(SCENARIOS.length, 18);
    assert.equal(new Set(SCENARIOS.map((item) => item.id)).size, 18);

    // A scenario stops measuring when the data set no longer answers its
    // question or the operation changes shape. Without this, a comparison
    // between profiles would produce a number that means nothing.
    const results = await runOracle();
    const broken = results.filter((item) => !item.correct || !item.viaExpectedPath);
    assert.deepEqual(
      broken.map((item) => `${item.scenario}: ${item.detail}`),
      [],
    );
  });
});
