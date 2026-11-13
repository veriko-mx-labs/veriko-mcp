/**
 * Fake SDK client fed by `data.json`.
 *
 * The evaluations touch neither the real API nor customer data: the data set is
 * fictitious and versioned next to the scenarios, so a run today and a run six
 * months from now start from the same place.
 *
 * It also records every call. An evaluation does not only check that the final
 * answer is right: it checks that the model took the tool it should have.
 */
import { readFileSync } from 'node:fs';

import {
  ApiError,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  type Veriko,
} from '@veriko-mx/sdk-runtime';

export interface Call {
  method: string;
  args: readonly unknown[];
}

export interface Data {
  validations: Array<Record<string, unknown>>;
  ceps: Record<string, { content: string; type: string }>;
  banks: Array<Record<string, unknown>>;
  bins: Record<string, Record<string, unknown>>;
  banxico: Record<string, unknown>;
  usage: { summary: Record<string, unknown>; limits: Record<string, unknown> };
  plans: Array<Record<string, unknown>>;
  webhooks: Array<Record<string, unknown>>;
  beneficiaries: Array<Record<string, unknown>>;
  insights: { top_banks: Array<Record<string, unknown>> };
}

export function loadData(): Data {
  const path = new URL('./data.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Data;
}

/** Ids the write scenarios use; they are not in `data.json` because the fake creates them. */
export const NEW_VALIDATION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const QUEUED_VALIDATION_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
export const CEP_EXPORT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
export const QUOTA_TRACKING_KEY = 'QUOTA-SPENT';
export const INVALID_TRACKING_KEY = 'TOO-MANY-CANDIDATES';

export function createFakeApi(data: Data): { client: Veriko; calls: Call[] } {
  const calls: Call[] = [];
  let queuedPolls = 0;
  let exportPolls = 0;

  const record =
    <T>(method: string, result: (...args: never[]) => T) =>
    (...args: never[]): Promise<T> => {
      calls.push({ method, args });
      try {
        return Promise.resolve(result(...args));
      } catch (error) {
        return Promise.reject(error);
      }
    };

  const find = (id: unknown): Record<string, unknown> => {
    const found = data.validations.find((item) => item.id === id);
    if (!found) throw new NotFoundError('not_found', { status: 404, code: 'not_found' });
    return found;
  };

  const validated = (args: { trackingKey?: string }) => {
    if (args.trackingKey === QUOTA_TRACKING_KEY) {
      throw new RateLimitError('Quota spent.', {
        status: 429,
        code: 'quota_exceeded',
        retryAfter: 864_000,
        errors: [{ code: 'quota_exceeded', detail: 'The monthly quota is spent.' }],
        headers: { 'x-quota-limit': '1300', 'x-quota-used': '1300', 'x-quota-remaining': '0' },
      });
    }
    if (args.trackingKey === INVALID_TRACKING_KEY) {
      throw new InvalidRequestError('Invalid.', {
        status: 422,
        code: 'validation_error',
        errors: [
          { code: 'validation_error', detail: 'The request is invalid.' },
          {
            code: 'candidate_accounts_too_many',
            detail: 'The list has more accounts than the service allows.',
            hint: 'Send at most 3 candidate accounts.',
            source: { pointer: '/candidate_accounts' },
            meta: { max: 3 },
          } as never,
        ],
      });
    }
    return {
      type: 'validation',
      id: NEW_VALIDATION_ID,
      attributes: { status: 'valid', tracking_key: args.trackingKey, account_cross_checked: true },
    };
  };

  const client = {
    validations: {
      list: record('validations.list', (args: { status?: string } | undefined) => {
        const status = args?.status;
        const items = status ? data.validations.filter((item) => item.status === status) : data.validations;
        return { items, total: items.length };
      }),
      get: record('validations.get', (id: string) => {
        if (id === QUEUED_VALIDATION_ID) {
          queuedPolls += 1;
          const status = queuedPolls < 3 ? 'processing' : 'valid';
          return { type: 'validation', id, attributes: { status }, etag: `W/"${queuedPolls}-${status}"` };
        }
        return find(id);
      }),
      cep: record('validations.cep', (id: string) => {
        const cep = data.ceps[id];
        if (!cep) throw new ConflictError('cep_unavailable', { status: 409, code: 'cep_unavailable' });
        return { filename: `CEP-${id}.pdf`, contentType: cep.type, content: Buffer.from(cep.content, 'base64') };
      }),
      validate: record('validations.validate', validated),
      enqueue: record('validations.enqueue', () => ({
        id: QUEUED_VALIDATION_ID,
        status: 'queued',
        nextPollAfterSeconds: 1,
        data: { type: 'validation', id: QUEUED_VALIDATION_ID, attributes: { status: 'queued' } },
      })),
    },
    catalog: {
      banks: record('catalog.banks', () => ({ data: data.banks })),
      binLookup: record('catalog.binLookup', (bin: string) => {
        const found = data.bins[bin];
        if (!found) throw new NotFoundError('not_found', { status: 404, code: 'not_found' });
        return { data: found };
      }),
      banxicoStatus: record('catalog.banxicoStatus', () => ({ data: data.banxico })),
    },
    usage: {
      summary: record('usage.summary', () => ({ data: data.usage.summary })),
      limits: record('usage.limits', () => ({ data: data.usage.limits })),
    },
    plans: {
      listPublic: record('plans.listPublic', () => ({ data: data.plans })),
    },
    webhooks: {
      list: record('webhooks.list', () => ({ data: data.webhooks })),
      create: record('webhooks.create', (args: { url: string; events: string[] }) => ({
        type: 'webhook_endpoint',
        id: 'wh_new1',
        attributes: { url: args.url, events: args.events, status: 'active', secret: 'whsec_fictitious' },
      })),
      test: record('webhooks.test', () => ({ delivered: true, response_status: 200 })),
      delete: record('webhooks.delete', () => undefined),
    },
    beneficiaries: {
      list: record('beneficiaries.list', () => ({ data: data.beneficiaries })),
      validateAccount: record('beneficiaries.validateAccount', (args: { account: string }) => ({
        account_type: args.account.length === 18 ? 'clabe' : 'unknown',
        checksum_valid: args.account === '012180004412345678',
      })),
    },
    finance: {
      createCepExport: record('finance.createCepExport', () => ({
        type: 'finance_cep_export',
        id: CEP_EXPORT_ID,
        attributes: { status: 'queued' },
      })),
      getCepExport: record('finance.getCepExport', () => {
        exportPolls += 1;
        return {
          type: 'finance_cep_export',
          id: CEP_EXPORT_ID,
          attributes: { status: exportPolls < 2 ? 'building' : 'ready' },
        };
      }),
      downloadCepExport: record('finance.downloadCepExport', () => ({
        filename: 'ceps-2026-09.zip',
        contentType: 'application/zip',
        content: Buffer.from('PK fictitious zip'),
      })),
    },
    insights: {
      getTopBanks: record('insights.getTopBanks', () => ({ data: data.insights.top_banks })),
    },
  } as unknown as Veriko;

  return { client, calls };
}

export { ApiError };
