import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runOracle } from '../evals/runner.js';
import { SCENARIOS } from '../evals/scenarios.js';

describe('evals', () => {
  it('cada escenario sigue siendo medible', { timeout: 60_000 }, async () => {
    assert.equal(SCENARIOS.length, 18);
    assert.equal(new Set(SCENARIOS.map((item) => item.id)).size, 18);

    // Un escenario deja de medir cuando el conjunto de datos ya no responde a su
    // pregunta o la operación cambia de forma. Sin esto, una comparación entre
    // perfiles daría un número que no significa nada.
    const results = await runOracle();
    const broken = results.filter((item) => !item.correct || !item.viaExpectedPath);
    assert.deepEqual(
      broken.map((item) => `${item.scenario}: ${item.detail}`),
      [],
    );
  });
});
