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

/** The headers of the most recent API response seen during one tool call. */
export interface CallCapture {
  headers?: Record<string, string>;
  /** The SDK metadata of the last successful response: replay, quota, rate limit, retry delay. */
  meta?: ResponseMeta;
  responses: number;
  /** Aborted when the MCP client cancels the request; every SDK call of the tool call obeys it. */
  signal?: AbortSignal;
}

const capture = new AsyncLocalStorage<CallCapture>();

/**
 * Runs `work` while recording the headers of every API response it triggers.
 * The SDK returns resource bodies only, so this is how the server reads
 * `Idempotent-Replayed`, `X-Quota-*` and `Retry-After`.
 */
export function withCapture<T>(store: CallCapture, work: () => Promise<T>): Promise<T> {
  return capture.run(store, work);
}

/** The cancellation signal of the running tool call, if any. */
export function currentSignal(): AbortSignal | undefined {
  return capture.getStore()?.signal;
}

/** The headers of the last API response of the running tool call, if any. */
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
    throw new Error(`${name} must be an integer between ${range.min} and ${range.max}.`);
  }
  return value;
}

/** Optional client tuning from the environment, kept apart from `config.ts`. */
export function clientTuningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ClientSettings, 'timeoutMs' | 'maxRetries' | 'acceptLanguage'> {
  const timeoutMs = integerFromEnv(env, 'VERIKO_TIMEOUT_MS', { min: 1_000, max: 300_000 });
  const maxRetries = integerFromEnv(env, 'VERIKO_MAX_RETRIES', { min: 0, max: 5 });
  const language = env.VERIKO_ACCEPT_LANGUAGE?.trim();
  if (language && language !== 'en' && language !== 'es') {
    throw new Error('VERIKO_ACCEPT_LANGUAGE must be en or es.');
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(language ? { acceptLanguage: language } : {}),
  };
}

/** The `User-Agent` prefix: `veriko-mcp/<version> (<transport>)`. The SDK appends its own token. */
export function userAgentPrefix(version: string, transportName: TransportName): string {
  return `veriko-mcp/${version} (${transportName})`;
}

/**
 * Builds the SDK client over a transport that records response headers.
 *
 * Retries stay short on purpose: a tool call must answer inside the host's
 * timeout, and a `429` carries its own `Retry-After` for the model to act on.
 * The SDK never retries `quota_exceeded`.
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
 * Makes every SDK call of a tool call obey the cancellation of its MCP request.
 *
 * `Transport.call` is the one place every operation goes through, and it takes
 * `signal` in its options: the SDK then also stops the retries and the pauses
 * between them. A signal a tool passes itself wins.
 */
function bindCancellation(transport: Transport): void {
  const call = transport.call.bind(transport) as (options: CallOptions | undefined, run: unknown) => unknown;
  transport.call = ((options: CallOptions | undefined, run: unknown) => {
    const signal = options?.signal ?? currentSignal();
    return call(signal ? { ...options, signal } : options, run);
  }) as unknown as typeof transport.call;
}

/** The transport behind a client, for the few operations the SDK does not wrap. */
export function transportOf(client: Veriko): Transport {
  const transport = (client as unknown as { transport?: Transport }).transport;
  if (!transport) throw new Error('The client does not expose its transport.');
  return transport;
}
