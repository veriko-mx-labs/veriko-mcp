import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiError,
  ConfigurationError,
  ConnectionError,
  RateLimitError,
  RequestAbortedError,
  TimeoutError,
  VerikoError,
} from '@veriko-mx/sdk-runtime';

import { ArtifactLimitError } from '../src/artifacts.js';
import { safeError } from '../src/errors.js';

describe('errores seguros', () => {
  it('no reenvía los mensajes internos del SDK', () => {
    const secret = 'veriko_secret_that_must_not_leave';
    for (const error of [
      new ConfigurationError(secret),
      new ConnectionError(secret, 3),
      new VerikoError(secret),
    ]) {
      assert.doesNotMatch(JSON.stringify(safeError(error)), /veriko_secret/);
    }
  });

  it('informa una petición cancelada como final, no como una falla de conexión', () => {
    const safe = safeError(new RequestAbortedError('aborted'));
    assert.equal(safe.code, 'cancelled');
    assert.equal(safe.retryable, false);
  });

  it('explica un archivo demasiado grande', () => {
    assert.deepEqual(safeError(new ArtifactLimitError(11, 10)), {
      type: 'ArtifactLimitError',
      code: 'artifact_too_large',
      message: 'El archivo supera el límite de recursos efímeros del servidor MCP.',
      retryable: false,
      size: 11,
      limit: 10,
    });
  });

  it('conserva cada entrada de un 422 con detail, hint, docs_url, pointer y meta', () => {
    const error = new ApiError('HTTP 422', {
      status: 422,
      code: 'validation_error',
      detail: 'The request is invalid.',
      requestId: 'req_1',
      errors: [
        { code: 'validation_error', detail: 'The request is invalid.' },
        {
          code: 'candidate_accounts_too_many',
          detail: 'Too many candidates.',
          hint: 'Send at most 3.',
          docs_url: 'https://docs.veriko.mx/en/concepts/errors-taxonomy',
          source: { pointer: '/candidate_accounts' },
          meta: { max: 3 },
        } as never,
      ],
    });

    const safe = safeError(error);

    assert.equal(safe.status, 422);
    assert.equal(safe.code, 'validation_error');
    assert.equal(safe.retryable, false);
    assert.equal(safe.request_id, 'req_1');
    assert.equal(safe.errors?.length, 2);
    assert.deepEqual(safe.errors?.[1], {
      code: 'candidate_accounts_too_many',
      detail: 'Too many candidates.',
      hint: 'Send at most 3.',
      docs_url: 'https://docs.veriko.mx/en/concepts/errors-taxonomy',
      pointer: '/candidate_accounts',
      meta: { max: 3 },
    });
    assert.equal(safe.docs_url, 'https://docs.veriko.mx/en/concepts/errors-taxonomy');
  });

  it('separa un 429 de cuota de un 429 de límite de frecuencia e informa retry_after_seconds', () => {
    const quota = safeError(
      new RateLimitError('x', { status: 429, code: 'quota_exceeded', retryAfter: 86_400, headers: {} }),
    );
    assert.equal(quota.kind, 'quota');
    assert.equal(quota.retryable, false);
    assert.equal(quota.retry_after_seconds, 86_400);

    const rate = safeError(
      new RateLimitError('x', { status: 429, code: 'rate_limit_exceeded', retryAfter: 7, headers: {} }),
    );
    assert.equal(rate.kind, 'rate_limit');
    assert.equal(rate.retryable, true);
    assert.equal(rate.retry_after_seconds, 7);
  });

  it('marca como reintentables los 5xx, los tiempos agotados y las claves de idempotencia en curso', () => {
    assert.equal(safeError(new ApiError('x', { status: 503, code: 'upstream_unavailable' })).retryable, true);
    assert.equal(
      safeError(new ApiError('x', { status: 409, code: 'idempotency_key_in_progress' })).retryable,
      true,
    );
    assert.equal(safeError(new ApiError('x', { status: 404, code: 'not_found' })).retryable, false);
    assert.equal(safeError(new TimeoutError('x', 'id', 1000)).retryable, true);
    assert.equal(safeError(new ConnectionError('x', 3)).code, 'connection_error');
  });

  it('recurre a una frase en español cuando la API no envía detail', () => {
    assert.match(safeError(new ApiError('x', { status: 500 })).message, /^Veriko rechazó la operación con http_500/);
  });
});
