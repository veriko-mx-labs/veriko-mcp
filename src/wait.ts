import {
  ApiError,
  isImportSettled,
  isSettled,
  type ApiPromise,
  type ResponseMeta,
  type Veriko,
} from '@veriko-mx/sdk-runtime';

import type { ToolRuntime } from './catalog.js';
import { abortedError } from './cancel.js';
import { currentHeaders } from './client.js';
import { CEP_EXPORT_TERMINAL_STATUSES } from './schemas.js';

/** Shortest and longest pause between two polls. The API suggests 2 seconds. */
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 10;
const DEFAULT_POLL_SECONDS = 2;
export const DEFAULT_WAIT_SECONDS = 25;

export interface WaitResult {
  /** The last state read, as the API returned it. */
  resource: unknown;
  /** The resource reached a state that no longer changes. */
  terminal: boolean;
  /** The time limit ended first: call the tool again. */
  waiting: boolean;
  status?: string;
  next_poll_after_seconds?: number;
  polls: number;
  waited_seconds: number;
}

/** One read of the resource, with the pause the API asked for in that same response. */
interface Reading<T> {
  value: T | 'not_modified';
  /** `meta.next_poll_after_seconds` or `Retry-After` of the response. */
  hintSeconds?: number | undefined;
}

interface Poll<T> {
  read(signal: AbortSignal | undefined): Promise<Reading<T>>;
  settled(value: T): boolean;
  statusOf(value: T): string | undefined;
}

/** What the SDK reports about the response of a call, as far as polling needs it. */
function hintOf(response: ResponseMeta): number | undefined {
  const advised = Number(response.meta.next_poll_after_seconds);
  if (Number.isFinite(advised) && advised > 0) return advised;
  return response.retryAfter !== undefined && response.retryAfter > 0 ? response.retryAfter : undefined;
}

async function readWith<T>(call: ApiPromise<T>): Promise<Reading<T>> {
  // A stand-in client (the evals' fake API) returns a plain promise: no metadata then.
  if (typeof call.withResponse !== 'function') return { value: await call };
  const { data, response } = await call.withResponse();
  return { value: data, hintSeconds: hintOf(response) };
}

function clampSeconds(value: number | undefined): number {
  const seconds = value !== undefined && Number.isFinite(value) ? value : DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.ceil(seconds)));
}

async function poll<T>(
  spec: Poll<T>,
  timeoutSeconds: number | undefined,
  runtime: ToolRuntime | undefined,
  pollHeaderSeconds: () => number | undefined,
): Promise<WaitResult> {
  const now = runtime?.now ?? (() => Date.now());
  const signal = runtime?.signal;
  const sleep = runtime?.sleep ?? ((milliseconds: number) => abortableSleep(milliseconds, signal));
  const startedAt = now();
  const budgetSeconds = timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
  const deadline = startedAt + budgetSeconds * 1000;
  let latest: T | undefined;
  let polls = 0;
  let next = DEFAULT_POLL_SECONDS;

  for (;;) {
    if (signal?.aborted) throw abortedError(signal);
    const reading = await spec.read(signal);
    polls += 1;
    if (reading.value !== 'not_modified') latest = reading.value;
    const status = latest !== undefined ? spec.statusOf(latest) : undefined;
    const waited = Math.round((now() - startedAt) / 1000);
    // One notification per read: the client can show that the wait is alive.
    await runtime?.progress?.({
      progress: polls,
      message: `${status ?? 'pending'}; waited ${waited} of ${budgetSeconds} seconds`,
    });
    if (latest !== undefined && spec.settled(latest)) {
      return {
        resource: latest,
        terminal: true,
        waiting: false,
        ...(status ? { status } : {}),
        polls,
        waited_seconds: waited,
      };
    }
    next = clampSeconds(reading.hintSeconds ?? pollHeaderSeconds());
    if (now() + next * 1000 >= deadline) break;
    await sleep(next * 1000);
  }

  const status = latest !== undefined ? spec.statusOf(latest) : undefined;
  return {
    resource: latest ?? null,
    terminal: false,
    waiting: true,
    ...(status ? { status } : {}),
    next_poll_after_seconds: next,
    polls,
    waited_seconds: Math.round((now() - startedAt) / 1000),
  };
}

/** A pause that ends at once, with an error, when the request is cancelled. */
function abortableSleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` of the last API response, read from the call capture. */
function retryAfterHeader(): number | undefined {
  const value = Number(currentHeaders()?.['retry-after']);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function waitForValidation(
  client: Veriko,
  args: { validation_id: string; timeout_seconds?: number | undefined },
  runtime?: ToolRuntime,
): Promise<WaitResult> {
  let etag: string | undefined;
  return poll(
    {
      async read(signal) {
        try {
          const reading = await readWith(
            client.validations.get(args.validation_id, {
              ...(etag ? { ifNoneMatch: etag } : {}),
              ...(signal ? { signal } : {}),
            }),
          );
          if (reading.value !== 'not_modified') etag = reading.value.etag ?? etag;
          return reading;
        } catch (error) {
          if (error instanceof ApiError && error.status === 304) return { value: 'not_modified' as const };
          throw error;
        }
      },
      settled: isSettled,
      statusOf: (validation) => validation.attributes.status,
    },
    args.timeout_seconds,
    runtime,
    retryAfterHeader,
  );
}

export function waitForCepExport(
  client: Veriko,
  args: { export_id: string; timeout_seconds?: number | undefined },
  runtime?: ToolRuntime,
): Promise<WaitResult> {
  const terminal: readonly string[] = CEP_EXPORT_TERMINAL_STATUSES;
  const statusOf = (value: unknown): string | undefined => {
    const status = (value as { attributes?: { status?: unknown }; status?: unknown }).attributes?.status;
    const direct = (value as { status?: unknown }).status;
    const found = status ?? direct;
    return typeof found === 'string' ? found : undefined;
  };
  return poll(
    {
      read: (signal) =>
        readWith(client.finance.getCepExport(args.export_id, signal ? { signal } : {})),
      settled: (value) => terminal.includes(statusOf(value) ?? ''),
      statusOf,
    },
    args.timeout_seconds,
    runtime,
    retryAfterHeader,
  );
}

export function waitForImport(
  client: Veriko,
  args: { import_id: string | number; timeout_seconds?: number | undefined },
  runtime?: ToolRuntime,
): Promise<WaitResult> {
  return poll(
    {
      read: (signal) =>
        readWith(client.beneficiaries.importStatus(args.import_id, signal ? { signal } : {})),
      settled: isImportSettled,
      statusOf: (job) => job.attributes?.status,
    },
    args.timeout_seconds,
    runtime,
    retryAfterHeader,
  );
}
