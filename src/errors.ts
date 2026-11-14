import {
  ApiError,
  ConfigurationError,
  ConnectionError,
  RateLimitError,
  RequestAbortedError,
  TimeoutError,
  VerikoError,
} from '@veriko-mx/sdk-runtime';

import { ArtifactLimitError } from './artifacts.js';
import { FileInputError } from './local-files.js';

/** Una entrada del arreglo `errors[]` de la API, tal como la ve el modelo. */
export interface ErrorEntry {
  code?: string;
  title?: string;
  detail?: string;
  hint?: string;
  docs_url?: string;
  pointer?: string;
  meta?: Record<string, unknown>;
}

export interface SafeError {
  type: string;
  /** Código legible por máquina. Decide según éste, nunca según `message` ni `detail`. */
  code: string;
  /** Texto para personas; libre y sin garantía de contrato. */
  message: string;
  status?: number;
  /** `quota` cuando se agotó la cuota del plan, `rate_limit` cuando las peticiones son demasiado frecuentes. */
  kind?: 'quota' | 'rate_limit';
  /** Si repetir la misma llamada puede funcionar sin cambiarla. */
  retryable: boolean;
  retry_after_seconds?: number;
  request_id?: string;
  /** Cada entrada de error de la API: primero el resumen y luego una por campo inválido con su `pointer`. */
  errors?: ErrorEntry[];
  meta?: Record<string, unknown>;
  docs_url?: string;
  quota?: { limit?: number; used?: number; remaining?: number; reset?: string };
  quota_warning?: string;
  /** El `Idempotency-Key` que usó esta llamada. Repítelo para reintentar sin riesgo. */
  idempotency_key?: string;
  resource_id?: string;
  timeout_ms?: number;
  attempts?: number;
  size?: number;
  limit?: number;
}

const MAX_ENTRIES = 25;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 2_000) : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entryOf(raw: unknown): ErrorEntry | undefined {
  const entry = plainObject(raw);
  if (!entry) return undefined;
  const source = plainObject(entry.source);
  const meta = plainObject(entry.meta);
  const result: ErrorEntry = {
    ...(text(entry.code) ? { code: text(entry.code) } : {}),
    ...(text(entry.title) ? { title: text(entry.title) } : {}),
    ...(text(entry.detail) ? { detail: text(entry.detail) } : {}),
    ...(text(entry.hint) ? { hint: text(entry.hint) } : {}),
    ...(text(entry.docs_url) ? { docs_url: text(entry.docs_url) } : {}),
    ...(source && text(source.pointer) ? { pointer: text(source.pointer) } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function retryAfterOf(error: ApiError): number | undefined {
  if (error instanceof RateLimitError && error.retryAfter !== undefined) return error.retryAfter;
  const header = Number(error.headers['retry-after']);
  if (Number.isFinite(header) && header >= 0) return header;
  const meta = error.meta.retry_after ?? error.errors.find((entry) => entry.meta?.retry_after)?.meta?.retry_after;
  return typeof meta === 'number' ? meta : undefined;
}

export function safeError(error: unknown): SafeError {
  if (error instanceof ApiError) {
    const code = error.code ?? `http_${error.status}`;
    const entries = error.errors
      .slice(0, MAX_ENTRIES)
      .map(entryOf)
      .filter((entry): entry is ErrorEntry => entry !== undefined);
    const kind =
      error.status === 429
        ? code === 'quota_exceeded'
          ? ('quota' as const)
          : ('rate_limit' as const)
        : undefined;
    const retryAfter = retryAfterOf(error);
    const docsUrl = entries.find((entry) => entry.docs_url)?.docs_url;
    const requestId = error.requestId ?? text(error.meta.request_id);
    const retryable =
      kind === 'rate_limit' ||
      error.status === 408 ||
      (error.status === 409 && code === 'idempotency_key_in_progress') ||
      error.status >= 500;
    return {
      type: error.name,
      code,
      message: text(error.detail) ?? `Veriko rechazó la operación con ${code} (HTTP ${error.status}).`,
      status: error.status,
      ...(kind ? { kind } : {}),
      retryable,
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(entries.length > 0 ? { errors: entries } : {}),
      ...(docsUrl ? { docs_url: docsUrl } : {}),
    };
  }
  if (error instanceof TimeoutError) {
    return {
      type: error.name,
      code: 'timeout',
      message: 'La espera terminó antes de que el recurso llegara a un estado final.',
      retryable: true,
      resource_id: error.resourceId,
      timeout_ms: error.timeoutMs,
    };
  }
  if (error instanceof ConfigurationError) {
    return {
      type: error.name,
      code: 'configuration_error',
      message: 'La operación necesita una configuración válida; revisa VERIKO_API_KEY y los argumentos.',
      retryable: false,
    };
  }
  if (error instanceof ConnectionError) {
    return {
      type: error.name,
      code: 'connection_error',
      message:
        'No se pudo contactar a Veriko tras los reintentos configurados. Si la llamada era una escritura, repítela con la misma idempotency_key.',
      retryable: true,
      attempts: error.attempts,
    };
  }
  if (error instanceof FileInputError) {
    return { type: error.name, code: 'invalid_file_path', message: error.message, retryable: false };
  }
  if (error instanceof ArtifactLimitError) {
    return {
      type: error.name,
      code: 'artifact_too_large',
      message: 'El archivo supera el límite de recursos efímeros del servidor MCP.',
      retryable: false,
      size: error.size,
      limit: error.limit,
    };
  }
  if (error instanceof RequestAbortedError) {
    return {
      type: error.name,
      code: 'cancelled',
      message: 'La petición se canceló antes de terminar. No se enviará nada más.',
      retryable: false,
    };
  }
  if (error instanceof VerikoError) {
    return {
      type: error.name,
      code: 'veriko_error',
      message: 'El SDK de Veriko rechazó la operación antes de que la API respondiera.',
      retryable: false,
    };
  }
  if (error instanceof TypeError && /idempotency_key/.test(error.message)) {
    return { type: error.name, code: 'invalid_idempotency_key', message: error.message, retryable: false };
  }
  if (error instanceof Error) {
    return {
      type: error.name,
      code: 'mcp_internal_error',
      message: 'El servidor MCP falló.',
      retryable: false,
    };
  }
  return { type: 'Error', code: 'mcp_internal_error', message: 'Error desconocido.', retryable: false };
}
