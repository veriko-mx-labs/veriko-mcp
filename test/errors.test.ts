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

describe('safe errors', () => {
  it('does not forward internal SDK messages', () => {
    const secret = 'veriko_secret_that_must_not_leave';
    for (const error of [
      new ConfigurationError(secret),
      new ConnectionError(secret, 3),
      new VerikoError(secret),
    ]) {
      assert.doesNotMatch(JSON.stringify(safeError(error)), /veriko_secret/);
    }
  });

  it('reports a cancelled request as final, not as a connection failure', () => {
    const safe = safeError(new RequestAbortedError('aborted'));
    assert.equal(safe.code, 'cancelled');
    assert.equal(safe.retryable, false);
  });

  it('explains an artifact that is too large', () => {
    assert.deepEqual(safeError(new ArtifactLimitError(11, 10)), {
      type: 'ArtifactLimitError',
      code: 'artifact_too_large',
      message: 'The file exceeds the ephemeral resource limit of the MCP server.',
      retryable: false,
      size: 11,
      limit: 10,
    });
  });

  it('keeps every entry of a 422 with detail, hint, docs_url, pointer and meta', () => {
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

  it('separates a quota 429 from a rate-limit 429 and reports retry_after_seconds', () => {
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

  it('marks 5xx, timeouts and in-progress idempotency keys as retryable', () => {
    assert.equal(safeError(new ApiError('x', { status: 503, code: 'upstream_unavailable' })).retryable, true);
    assert.equal(
      safeError(new ApiError('x', { status: 409, code: 'idempotency_key_in_progress' })).retryable,
      true,
    );
    assert.equal(safeError(new ApiError('x', { status: 404, code: 'not_found' })).retryable, false);
    assert.equal(safeError(new TimeoutError('x', 'id', 1000)).retryable, true);
    assert.equal(safeError(new ConnectionError('x', 3)).code, 'connection_error');
  });

  it('falls back to an English sentence when the API sends no detail', () => {
    assert.match(safeError(new ApiError('x', { status: 500 })).message, /^Veriko rejected the operation with http_500/);
  });
});
