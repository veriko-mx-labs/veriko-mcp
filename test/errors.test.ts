import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigurationError, ConnectionError, VerikoError } from '@veriko-mx/sdk-runtime';

import { ArtifactLimitError } from '../src/artifacts.js';
import { safeError } from '../src/errors.js';

describe('errores seguros', () => {
  it('no reenvía mensajes internos del SDK', () => {
    const secret = 'veriko_secreto_que_no_debe_salir';
    for (const error of [
      new ConfigurationError(secret),
      new ConnectionError(secret, 3),
      new VerikoError(secret),
    ]) {
      assert.doesNotMatch(JSON.stringify(safeError(error)), /veriko_secreto/);
    }
  });

  it('explica de forma segura un artefacto demasiado grande', () => {
    assert.deepEqual(safeError(new ArtifactLimitError(11, 10)), {
      type: 'ArtifactLimitError',
      code: 'artifact_too_large',
      message: 'El archivo excede el límite de recursos efímeros del servidor MCP.',
      size: 11,
      limit: 10,
    });
  });
});
