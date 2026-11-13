import type { ResponseMeta } from '@veriko-mx/sdk-runtime';

import type { SafeError } from './errors.js';

export interface QuotaInfo {
  limit?: number;
  used?: number;
  remaining?: number;
  reset?: string;
}

export interface CallInfo {
  idempotency_key?: string;
  idempotent_replayed?: boolean;
  request_id?: string;
  quota?: QuotaInfo;
  quota_warning?: string;
  rate_limit?: RateLimit;
  retry_after_seconds?: number;
  /** `Deprecation` and `Sunset` of the operation, verbatim, when the API announces its retirement. */
  deprecation?: string;
  sunset?: string;
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  /** ISO 8601 time the window resets. */
  reset?: string;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function quotaFrom(headers: Record<string, string> | undefined): QuotaInfo | undefined {
  if (!headers) return undefined;
  const limit = number(headers['x-quota-limit']);
  const used = number(headers['x-quota-used']);
  const remaining = number(headers['x-quota-remaining']);
  const reset = headers['x-quota-reset'];
  const quota: QuotaInfo = {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset ? { reset } : {}),
  };
  return Object.keys(quota).length > 0 ? quota : undefined;
}

/** A plain-English warning when the allowance is low or spent. */
export function quotaWarning(quota: QuotaInfo | undefined): string | undefined {
  if (!quota || quota.remaining === undefined) return undefined;
  if (quota.remaining <= 0) {
    return `The quota is spent${quota.reset ? ` until ${quota.reset}` : ''}. Further validations answer 429 \`quota_exceeded\`; changing plan or waiting for the next cycle clears it.`;
  }
  if (quota.limit && quota.remaining / quota.limit <= 0.1) {
    return `Only ${quota.remaining} of ${quota.limit} validations remain in this cycle${quota.reset ? ` (resets ${quota.reset})` : ''}. Confirm before validating in bulk.`;
  }
  return undefined;
}

function defined<T extends object>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

/**
 * What the model learns from the response of one call, read from the SDK
 * response metadata: replay, quota, rate limit, request id, retry delay and the
 * deprecation of the operation.
 */
export function callInfoFrom(
  meta: ResponseMeta | undefined,
  idempotencyKey: string | undefined,
): CallInfo | undefined {
  const quota = meta?.quota
    ? quotaFrom({
        ...(meta.quota.limit !== undefined ? { 'x-quota-limit': String(meta.quota.limit) } : {}),
        ...(meta.quota.used !== undefined ? { 'x-quota-used': String(meta.quota.used) } : {}),
        ...(meta.quota.remaining !== undefined ? { 'x-quota-remaining': String(meta.quota.remaining) } : {}),
        ...(meta.quota.reset ? { 'x-quota-reset': meta.quota.reset } : {}),
      })
    : undefined;
  const warning = quotaWarning(quota);
  const reset = meta?.rateLimit?.reset;
  const rateLimit = meta?.rateLimit
    ? defined({
        ...(meta.rateLimit.limit !== undefined ? { limit: meta.rateLimit.limit } : {}),
        ...(meta.rateLimit.remaining !== undefined ? { remaining: meta.rateLimit.remaining } : {}),
        ...(reset && !Number.isNaN(reset.getTime()) ? { reset: reset.toISOString() } : {}),
      })
    : undefined;
  const info: CallInfo = {
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(meta?.replayed === true ? { idempotent_replayed: true } : {}),
    ...(meta?.requestId ? { request_id: meta.requestId } : {}),
    ...(quota ? { quota } : {}),
    ...(warning ? { quota_warning: warning } : {}),
    ...(rateLimit ? { rate_limit: rateLimit } : {}),
    ...(meta?.retryAfter !== undefined ? { retry_after_seconds: meta.retryAfter } : {}),
    ...(meta?.deprecation ? { deprecation: meta.deprecation } : {}),
    ...(meta?.sunset ? { sunset: meta.sunset } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

/** Adds the quota facts of an API error response to a safe error. */
export function withErrorHeaders(
  error: SafeError,
  headers: Record<string, string> | undefined,
): SafeError {
  const quota = quotaFrom(headers);
  const warning = quotaWarning(quota);
  return {
    ...error,
    ...(quota ? { quota } : {}),
    ...(warning ? { quota_warning: warning } : {}),
  };
}
