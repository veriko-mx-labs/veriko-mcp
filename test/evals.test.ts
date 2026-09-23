import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { correrOraculo } from '../evals/runner.js';
import { ESCENARIOS } from '../evals/escenarios.js';

describe('evaluaciones', () => {
  it('los diez escenarios siguen siendo medibles', { timeout: 30_000 }, async () => {
    assert.equal(ESCENARIOS.length, 10);
    assert.equal(new Set(ESCENARIOS.map((item) => item.id)).size, 10);

    // Un escenario deja de medir cuando el conjunto de datos ya no responde su
    // pregunta o la operación cambia de forma. Sin esto, una comparativa entre
    // perfiles daría una cifra que no significa nada.
    const resultados = await correrOraculo();
    const rotos = resultados.filter((item) => !item.correcto || !item.porElCaminoEsperado);
    assert.deepEqual(
      rotos.map((item) => `${item.escenario}: ${item.detalle}`),
      [],
    );
  });
});
