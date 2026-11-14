import { AsyncLocalStorage } from 'node:async_hooks';

import {
  DEFAULT_BASE_URL,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  Transport,
  Veriko,
  buildUserAgent,
  type CallOptions,
  type ResponseMeta,
} from '@veriko-mx/sdk-runtime';

/** Los encabezados de la respuesta más reciente de la API durante una llamada a una herramienta. */
export interface CallCapture {
  headers?: Record<string, string>;
  /** Los metadatos del SDK de la última respuesta exitosa: repetición, cuota, límite de frecuencia, espera para reintentar. */
  meta?: ResponseMeta;
  responses: number;
  /** Se cancela cuando el cliente MCP cancela la petición; cada llamada al SDK de la herramienta la respeta. */
  signal?: AbortSignal;
}

const capture = new AsyncLocalStorage<CallCapture>();

/**
 * Ejecuta `work` y registra los encabezados de cada respuesta de la API que provoca.
 * El SDK devuelve sólo el cuerpo de los recursos, así que así lee el servidor
 * `Idempotent-Replayed`, `X-Quota-*` y `Retry-After`.
 */
export function withCapture<T>(store: CallCapture, work: () => Promise<T>): Promise<T> {
  return capture.run(store, work);
}

/** La señal de cancelación de la llamada en curso, si hay. */
export function currentSignal(): AbortSignal | undefined {
  return capture.getStore()?.signal;
}

/** Los encabezados de la última respuesta de la API de la llamada en curso, si hay. */
export function currentHeaders(): Record<string, string> | undefined {
  return capture.getStore()?.headers;
}

const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const store = capture.getStore();
  if (store) {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    store.headers = headers;
    store.responses += 1;
  }
  return response;
};

export type TransportName = 'stdio' | 'http';

export interface ClientSettings {
  apiKey: string;
  baseUrl?: string;
  transportName: TransportName;
  version: string;
  timeoutMs?: number;
  maxRetries?: number;
  acceptLanguage?: string;
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  range: { min: number; max: number },
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} debe ser un entero entre ${range.min} y ${range.max}.`);
  }
  return value;
}

/** Ajustes opcionales del cliente tomados del entorno, separados de `config.ts`. */
export function clientTuningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ClientSettings, 'timeoutMs' | 'maxRetries' | 'acceptLanguage'> {
  const timeoutMs = integerFromEnv(env, 'VERIKO_TIMEOUT_MS', { min: 1_000, max: 300_000 });
  const maxRetries = integerFromEnv(env, 'VERIKO_MAX_RETRIES', { min: 0, max: 5 });
  const language = env.VERIKO_ACCEPT_LANGUAGE?.trim();
  if (language && language !== 'en' && language !== 'es') {
    throw new Error('VERIKO_ACCEPT_LANGUAGE debe ser en o es.');
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(language ? { acceptLanguage: language } : {}),
  };
}

/** El prefijo del `User-Agent`: `veriko-mcp/<versión> (<transporte>)`. El SDK agrega su propio token. */
export function userAgentPrefix(version: string, transportName: TransportName): string {
  return `veriko-mcp/${version} (${transportName})`;
}

/**
 * Construye el cliente del SDK sobre un transporte que registra los encabezados de las respuestas.
 *
 * Los reintentos se mantienen cortos a propósito: una llamada a una herramienta
 * debe responder dentro del tiempo límite del host, y un `429` trae su propio
 * `Retry-After` para que el modelo actúe. El SDK nunca reintenta `quota_exceeded`.
 */
export function createClient(settings: ClientSettings): Veriko {
  const transport = new Transport({
    baseUrl: settings.baseUrl ?? process.env.VERIKO_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: {
      ...DEFAULT_RETRY,
      maxRetries: settings.maxRetries ?? 2,
      backoffMaxMs: 2_000,
      respectRetryAfter: false,
    },
    userAgent: buildUserAgent(userAgentPrefix(settings.version, settings.transportName)),
    acceptLanguage: settings.acceptLanguage ?? 'en',
    fetchImpl: recordingFetch,
    onResponse(meta) {
      const store = capture.getStore();
      if (store) store.meta = meta;
    },
  });
  bindCancellation(transport);
  return new Veriko({ apiKey: settings.apiKey, transport });
}

/**
 * Hace que cada llamada al SDK de una llamada a una herramienta obedezca la
 * cancelación de su petición MCP.
 *
 * `Transport.call` es el único punto por donde pasa cada operación y recibe
 * `signal` en sus opciones: así el SDK también detiene los reintentos y las
 * pausas entre ellos. Una señal que la herramienta pase por su cuenta tiene prioridad.
 */
function bindCancellation(transport: Transport): void {
  const call = transport.call.bind(transport) as (options: CallOptions | undefined, run: unknown) => unknown;
  transport.call = ((options: CallOptions | undefined, run: unknown) => {
    const signal = options?.signal ?? currentSignal();
    return call(signal ? { ...options, signal } : options, run);
  }) as unknown as typeof transport.call;
}

/** El transporte detrás de un cliente, para las pocas operaciones que el SDK no envuelve. */
export function transportOf(client: Veriko): Transport {
  const transport = (client as unknown as { transport?: Transport }).transport;
  if (!transport) throw new Error('El cliente no expone su transporte.');
  return transport;
}
