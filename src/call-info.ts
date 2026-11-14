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
  /** `Deprecation` y `Sunset` de la operación, tal cual, cuando la API anuncia su retiro. */
  deprecation?: string;
  sunset?: string;
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  /** Momento ISO 8601 en que se reinicia la ventana. */
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

/** Una advertencia en lenguaje claro cuando el saldo es bajo o se agotó. */
export function quotaWarning(quota: QuotaInfo | undefined): string | undefined {
  if (!quota || quota.remaining === undefined) return undefined;
  if (quota.remaining <= 0) {
    return `La cuota se agotó${quota.reset ? ` hasta ${quota.reset}` : ''}. Las validaciones siguientes responden 429 \`quota_exceeded\`; cambiar de plan o esperar al siguiente ciclo lo resuelve.`;
  }
  if (quota.limit && quota.remaining / quota.limit <= 0.1) {
    return `Sólo quedan ${quota.remaining} de ${quota.limit} validaciones en este ciclo${quota.reset ? ` (se reinicia ${quota.reset})` : ''}. Confirma antes de validar en lote.`;
  }
  return undefined;
}

function defined<T extends object>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

/**
 * Lo que el modelo aprende de la respuesta de una llamada, leído de los
 * metadatos de la respuesta del SDK: repetición, cuota, límite de frecuencia,
 * id de la petición, espera para reintentar y obsolescencia de la operación.
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

/** Agrega a un error seguro los datos de cuota de la respuesta de error de la API. */
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
