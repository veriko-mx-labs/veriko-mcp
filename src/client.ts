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

/** Tope de un token de acceso OAuth: el JWT lleva la lista de permisos y pasa de 1 KB con el nivel Completo. */
export const MAX_ACCESS_TOKEN_LENGTH = 8192;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Si el valor tiene la forma de un token de acceso OAuth de Veriko: un JWT con `typ: at+jwt` (RFC 9068).
 * Sólo mira la cabecera. El servidor HTTP verifica firma, emisor, vigencia y audiencia (access-token.ts) y la API los
 * vuelve a verificar.
 */
export function isAccessTokenShape(token: string): boolean {
  if (token.length > MAX_ACCESS_TOKEN_LENGTH || !JWT_PATTERN.test(token)) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && (header as { typ?: unknown }).typ === 'at+jwt';
  } catch {
    return false;
  }
}

/**
 * El SDK sólo acepta claves con la forma `veriko_` y 64 caracteres hexadecimales. Con un token OAuth se le pasa esta
 * clave de relleno y el encabezado se reemplaza por el token en cada petición; la clave de relleno nunca sale.
 */
const OAUTH_PLACEHOLDER_KEY = `veriko_${'0'.repeat(64)}`;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Si `url` es de la API: el mismo origen que `baseUrl` y su ruta debajo de la de `baseUrl` (`https://api.veriko.mx/v1`
 * cubre `/v1/validations`, no `/v1x` ni `/otra`).
 */
export function isUnderBaseUrl(url: string, baseUrl: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(baseUrl)) return false;
  const target = new URL(url);
  const base = new URL(baseUrl);
  if (target.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, '');
  return prefix === '' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

/**
 * La credencial (clave de API o token OAuth) sólo viaja a la API. Una petición a cualquier otra URL (una descarga
 * firmada en otro dominio) sale sin `Authorization`. Una petición con credencial no sigue redirecciones
 * (`redirect: 'error'`): la API no responde 3xx, y seguir una en el mismo origen llevaría el encabezado fuera de la ruta
 * de la API.
 */
export function credentialsOnlyTo(baseUrl: string, token: string | undefined, inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (!isUnderBaseUrl(requestUrl(input), baseUrl)) {
      headers.delete('authorization');
      return inner(input, { ...init, headers });
    }
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    return inner(input, { ...init, headers, redirect: 'error' });
  };
}

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
  const oauth = isAccessTokenShape(settings.apiKey);
  const apiKey = oauth ? OAUTH_PLACEHOLDER_KEY : settings.apiKey;
  const baseUrl = settings.baseUrl ?? process.env.VERIKO_BASE_URL ?? DEFAULT_BASE_URL;
  const transport = new Transport({
    baseUrl,
    apiKey,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: {
      ...DEFAULT_RETRY,
      maxRetries: settings.maxRetries ?? 2,
      backoffMaxMs: 2_000,
      respectRetryAfter: false,
    },
    userAgent: buildUserAgent(userAgentPrefix(settings.version, settings.transportName)),
    acceptLanguage: settings.acceptLanguage ?? 'en',
    fetchImpl: credentialsOnlyTo(baseUrl, oauth ? settings.apiKey : undefined, recordingFetch),
    onResponse(meta) {
      const store = capture.getStore();
      if (store) store.meta = meta;
    },
  });
  bindCancellation(transport);
  return new Veriko({ apiKey, transport });
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
