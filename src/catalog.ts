import type {
  ValidateOcrParams,
  ValidateTransferParams,
  Veriko,
} from '@veriko-mx/sdk-runtime';
import { ApiError } from '@veriko-mx/sdk-runtime';
import type { z } from 'zod';

import { transportOf } from './client.js';
import { type Family, type Profile, type Risk, riskAllowed } from './config.js';
import { resolveIdempotencyKey } from './idempotency.js';
import { IMPORT_RULES, RECEIPT_RULES, readLocalFile, type FileAccess } from './local-files.js';
import {
  allDeliveriesSchema,
  banxicoTimeseriesSchema,
  banksSchema,
  beneficiaryIdSchema,
  beneficiaryLookupSchema,
  binSchema,
  createBeneficiarySchema,
  createImportLocalSchema,
  createImportSchema,
  createWebhookSchema,
  dashboardSchema,
  digitsOf,
  downloadCepSchema,
  editImportRowSchema,
  emptySchema,
  exportAllDeliveriesSchema,
  exportBeneficiariesSchema,
  exportUsageSchema,
  exportValidationsSchema,
  exportWebhookDeliveriesSchema,
  financeAccountingSchema,
  financeCepExportCreateSchema,
  financeCepExportIdSchema,
  financeCepsSchema,
  financePreviewSchema,
  financeStatementSchema,
  financeSummarySchema,
  getValidationSchema,
  importIdSchema,
  importPreviewSchema,
  importRowSchema,
  importTemplateSchema,
  listBeneficiariesSchema,
  listValidationsSchema,
  regenerateWebhookSecretSchema,
  speiCalendarSchema,
  topBanksSchema,
  topBeneficiariesSchema,
  trendsSchema,
  updateBeneficiarySchema,
  updateMyRetryPolicySchema,
  updateWebhookSchema,
  usageBreakdownSchema,
  usageHeatmapSchema,
  usageHistorySchema,
  validateAccountSchema,
  validateDirectSchema,
  validateOcrLocalSchema,
  validateOcrSchema,
  validationFiltersSchema,
  validationIdSchema,
  validationIdempotentSchema,
  validationRetryPolicySchema,
  waitForCepExportSchema,
  waitForImportSchema,
  waitForValidationSchema,
  webhookDeliveriesSchema,
  webhookIdSchema,
} from './schemas.js';
import { waitForCepExport, waitForImport, waitForValidation } from './wait.js';

/**
 * Public operations the catalog does not announce as tools.
 *
 * A permanent purge of a validation cannot be undone, and an assistant must not
 * be able to delete data that way. Both exist in the spec and in the SDK:
 * `check:surface` counts them, but no profile or risk level exposes them.
 */
export const NOT_EXPOSED_OPERATIONS = [
  'prepareValidationPurge',
  'executeValidationPurge',
] as const;

type Cost = 'none' | 'included' | 'quota';
type InputSchema = z.ZodType<Record<string, unknown>>;

/** What a tool call shares with the server around it. */
export interface ToolRuntime {
  /** Set by the tool when it sends an `Idempotency-Key`, so the server can report it. */
  idempotencyKey?: string;
  /** Aborted when the client cancels the request. Long waits and every SDK call obey it. */
  signal?: AbortSignal | undefined;
  /** Reports progress to the client. Present only when the request carries a `progressToken`. */
  progress?: ((update: { progress: number; total?: number; message?: string }) => Promise<void>) | undefined;
  /** What the tool may read from the local disk; absent over HTTP and without roots. */
  files?: FileAccess | undefined;
  /** Replaces the real clock and timer in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface ToolDefinition {
  operationId: string;
  /** `true` for tools that compose several calls and are not an API operation. */
  helper: boolean;
  name: string;
  title: string;
  description: string;
  family: Family;
  risk: Risk;
  cost: Cost;
  core: boolean;
  /** Repeating the call with the same arguments leaves the same state. */
  idempotent: boolean;
  /** The call can delete or overwrite data. */
  destructive: boolean;
  /** The call reaches beyond the Veriko API (Banxico, or a URL the caller supplies). */
  openWorld: boolean;
  inputSchema: InputSchema;
  /** The schema to advertise instead when the server may read local files (stdio, with roots). */
  localInputSchema?: InputSchema;
  /**
   * The question to put to the person before the call runs, when the client can
   * ask. Absent for tools that need no confirmation.
   */
  confirmation?(args: Record<string, unknown>): string;
  invoke(client: Veriko, args: Record<string, unknown>, runtime?: ToolRuntime): Promise<unknown>;
}

interface DefinitionOptions<T extends InputSchema> {
  operationId: string;
  helper?: boolean;
  title: string;
  description: string;
  family: Family;
  risk?: Risk;
  cost?: Cost;
  core?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  /** The tool sends an `Idempotency-Key`: the caller's, or a fresh random one. */
  idempotencyKey?: boolean;
  inputSchema: T;
  /** Replaces `inputSchema` when the server may read local files. */
  localInputSchema?: InputSchema;
  /** The question to confirm before the call, from the validated arguments. */
  confirmation?(args: z.output<T>): string;
  invoke(client: Veriko, args: z.output<T>, runtime: ToolRuntime): Promise<unknown>;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * The cost lives in `_meta`, which the model does not read. The description it
 * does read, so the warning goes there. An agent loop can spend a monthly quota
 * in minutes.
 */
export const QUOTA_WARNING =
  'Each validation consumes quota from the account plan, deducted when the request is accepted. Read the remaining allowance with `veriko_get_usage_limits` before validating in bulk.';

function describe(description: string, cost: Cost): string {
  return cost === 'quota' ? `${description} ${QUOTA_WARNING}` : description;
}

function define<T extends InputSchema>(options: DefinitionOptions<T>): ToolDefinition {
  const cost = options.cost ?? 'included';
  const risk = options.risk ?? 'read';
  return {
    operationId: options.operationId,
    helper: options.helper ?? false,
    name: `veriko_${snakeCase(options.operationId)}`,
    title: options.title,
    description: describe(options.description, cost),
    family: options.family,
    risk,
    cost,
    core: options.core ?? false,
    idempotent: options.idempotent ?? risk === 'read',
    destructive: options.destructive ?? risk === 'destructive',
    openWorld: options.openWorld ?? false,
    inputSchema: options.inputSchema,
    ...(options.localInputSchema ? { localInputSchema: options.localInputSchema } : {}),
    ...(options.confirmation
      ? {
          confirmation: (args: Record<string, unknown>) =>
            (options.confirmation as (value: z.output<T>) => string)(options.inputSchema.parse(args) as z.output<T>),
        }
      : {}),
    invoke(client, args, runtime = {}) {
      const schema = runtime.files && options.localInputSchema ? options.localInputSchema : options.inputSchema;
      const parsed = schema.parse(args) as z.output<T>;
      if (options.idempotencyKey) {
        runtime.idempotencyKey = resolveIdempotencyKey(
          (parsed as { idempotency_key?: unknown }).idempotency_key,
        );
      }
      return options.invoke(client, parsed, runtime);
    },
  };
}

/** `snake_case` tool input to the `camelCase` the SDK takes. Nested objects stay as they are. */
export function toSdk<T extends Record<string, unknown>>(
  args: T,
  omit: readonly string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || omit.includes(key)) continue;
    result[key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  return result;
}

/** A tri-state scope, `0` and `1` as the API names them, to the SDK boolean. */
function scope(args: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = args[field];
  return value === undefined ? {} : { [field.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())]: value === 1 };
}

function filters(args: Record<string, unknown>): Record<string, unknown> {
  return { ...toSdk(args, ['with_deleted']), ...scope(args, 'with_deleted') };
}

/** A `304` answers a conditional read: it is a success meaning "unchanged". */
async function conditional<T>(
  call: Promise<T>,
  etag: string | undefined,
): Promise<T | { not_modified: true; etag?: string }> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && error.status === 304) {
      return { not_modified: true, ...(etag ? { etag } : {}) };
    }
    throw error;
  }
}

function accountDigits(value: string): string {
  return digitsOf(value);
}

const GUIDE_VERDICT =
  'The verdict is in `attributes.status`: `valid` (the CEP exists and matches), `not_found`, `cep_unavailable`, `returned`, `invalid`, `failed` or `error`. A `not_found` right away does not prove the transfer does not exist: Banxico may not have published the CEP yet, so enable `retry_policy` or check again later. `valid` is a snapshot: call `veriko_recheck_validation` within 72 hours to detect a return. When `attributes.account_cross_checked` is `false`, `valid` confirms the transfer exists but not that it was paid to the expected account.';

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  define({
    operationId: 'validateDirect',
    title: 'Validate a SPEI transfer',
    description: `Validates a transfer from its data against the Banxico CEP. Send \`amount\`, \`tracking_key\` or \`numeric_reference\`, and \`beneficiary_account\` or \`candidate_accounts\`. ${GUIDE_VERDICT}`,
    family: 'validations',
    risk: 'write',
    cost: 'quota',
    core: true,
    openWorld: true,
    idempotencyKey: true,
    inputSchema: validateDirectSchema,
    async invoke(client, args, runtime) {
      const { async, ...rest } = args;
      const params = {
        ...toSdk(rest, ['idempotency_key']),
        idempotencyKey: runtime.idempotencyKey,
      } as unknown as ValidateTransferParams;
      return async ? client.validations.enqueue(params) : client.validations.validate(params);
    },
  }),
  define({
    operationId: 'validateOcr',
    title: 'Validate a receipt by OCR',
    description: `Extracts and validates a transfer from a receipt: an image or a PDF of 1 to 3 pages, given as an HTTPS URL (\`image_url\`, preferred) or as base64. ${GUIDE_VERDICT}`,
    family: 'validations',
    risk: 'write',
    cost: 'quota',
    core: true,
    openWorld: true,
    idempotencyKey: true,
    inputSchema: validateOcrSchema,
    localInputSchema: validateOcrLocalSchema,
    async invoke(client, args, runtime) {
      const { async, image_base64, image_path, ...rest } = args as typeof args & { image_path?: string };
      const image = image_path
        ? (await readLocalFile(image_path, runtime.files, RECEIPT_RULES)).bytes
        : image_base64
          ? Buffer.from(image_base64, 'base64')
          : undefined;
      const params = {
        ...toSdk(rest, ['idempotency_key']),
        ...(image ? { image } : {}),
        idempotencyKey: runtime.idempotencyKey,
      } as unknown as ValidateOcrParams;
      return async ? client.validations.enqueueOcr(params) : client.validations.validateOcr(params);
    },
  }),
  define({
    operationId: 'waitForValidation',
    helper: true,
    title: 'Wait for a validation verdict',
    description:
      'Polls a validation until it reaches a final state (`valid`, `not_found`, `cep_unavailable`, `invalid`, `returned`, `failed`, `error`), honoring the API polling interval, for up to `timeout_seconds` (default 25). Returns the last state with `waiting`, `terminal` and `next_poll_after_seconds`; when `waiting` is `true`, call it again. Use it after an async or `processing` validation. It consumes no quota.',
    family: 'validations',
    core: true,
    inputSchema: waitForValidationSchema,
    invoke: (client, args, runtime) => waitForValidation(client, args, runtime),
  }),
  define({
    operationId: 'listValidations',
    title: 'List validations',
    description:
      'Lists validations, newest first, with filters and pagination (`per_page` up to 50). Narrow the filters when the answer is large.',
    family: 'validations',
    core: true,
    inputSchema: listValidationsSchema,
    invoke: (client, args) => client.validations.list(filters(args)),
  }),
  define({
    operationId: 'getValidation',
    title: 'Get a validation',
    description:
      'Reads a validation by id, with its ETag. Send `if_none_match` with the last ETag to get `{ not_modified: true }` when nothing changed. While the state is `queued` or `processing`, wait with `veriko_wait_for_validation` instead of polling.',
    family: 'validations',
    core: true,
    inputSchema: getValidationSchema,
    invoke: (client, { validation_id, if_none_match }) =>
      conditional(
        client.validations.get(validation_id, if_none_match ? { ifNoneMatch: if_none_match } : {}),
        if_none_match,
      ),
  }),
  define({
    operationId: 'downloadCep',
    title: 'Download the CEP',
    description:
      'Downloads the official Banxico receipt (CEP) as XML or PDF. The XML comes back as text in the result when it is small. Exists once the validation has a CEP (`valid` or `returned`).',
    family: 'validations',
    core: true,
    inputSchema: downloadCepSchema,
    invoke: (client, { validation_id, format }) => client.validations.cep(validation_id, { format }),
  }),
  define({
    operationId: 'getValidationImage',
    title: 'Download a validation receipt image',
    description:
      'Downloads the original receipt (image or PDF) of an OCR validation. Answers 410 `image_not_retained` when the validation was created with `retain_image: false`.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.image(validation_id),
  }),
  define({
    operationId: 'validationStats',
    title: 'Get validation statistics',
    description: 'Counts validations by state, applying the same filters as the list (`status` does not change the counters).',
    family: 'validations',
    inputSchema: validationFiltersSchema,
    invoke: (client, args) => client.validations.stats(filters(args)),
  }),
  define({
    operationId: 'exportValidations',
    title: 'Export validations',
    description: 'Exports the filtered history as a CSV or XLSX file (up to 100000 rows).',
    family: 'validations',
    inputSchema: exportValidationsSchema,
    invoke: (client, args) => client.validations.export(filters(args)),
  }),
  define({
    operationId: 'recheckValidation',
    title: 'Recheck a validation payment',
    description:
      'Asks Banxico again for the payment state of a `valid` validation created at most 72 hours ago, and moves it to `returned` if the payment was sent back. It consumes no quota. Rate limited to one check per 10 minutes (429 `recheck_rate_limited`).',
    family: 'validations',
    risk: 'write',
    openWorld: true,
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.recheck(validation_id),
  }),
  define({
    operationId: 'listValidationRetryAttempts',
    title: 'List validation retry attempts',
    description: 'Lists the attempts of the automatic retry cycle of a validation.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.retryAttempts(validation_id),
  }),
  define({
    operationId: 'updateValidationRetryPolicy',
    title: 'Change the retries of a validation',
    description:
      'Replaces the automatic retry policy of one validation. Retries consume no quota. The plan caps `max_retries`.',
    family: 'validations',
    risk: 'write',
    idempotent: true,
    destructive: true,
    idempotencyKey: true,
    inputSchema: validationRetryPolicySchema,
    confirmation: (args) =>
      `Replace the retry policy of validation ${args.validation_id} with ${JSON.stringify(args.retry_policy)}? The previous policy is overwritten.`,
    invoke: (client, args, runtime) =>
      client.validations.setRetryPolicy(args.validation_id, args.retry_policy, {
        idempotencyKey: runtime.idempotencyKey,
      }),
  }),
  define({
    operationId: 'cancelValidationRetries',
    title: 'Cancel the retries of a validation',
    description: 'Cancels the pending automatic retries of a validation. The validation keeps its current state.',
    family: 'validations',
    risk: 'destructive',
    idempotent: true,
    idempotencyKey: true,
    inputSchema: validationIdempotentSchema,
    invoke: (client, args, runtime) =>
      client.validations.cancelRetries(args.validation_id, { idempotencyKey: runtime.idempotencyKey }),
  }),
  define({
    operationId: 'deleteValidation',
    title: 'Withdraw a validation',
    description:
      'Withdraws a validation from the visible history (soft delete). It does not purge the data; list withdrawn ones with `with_deleted: 1`.',
    family: 'validations',
    risk: 'destructive',
    idempotent: true,
    inputSchema: validationIdSchema,
    confirmation: (args) =>
      `Withdraw validation ${args.validation_id} from the visible history? The data is kept; it only leaves the default list.`,
    invoke: (client, { validation_id }) => client.validations.delete(validation_id),
  }),
  define({
    operationId: 'sendCepToTelegram',
    title: 'Send the CEP to Telegram',
    description: 'Sends the CEP through the Telegram integration configured on the account. Answers 409 when none is linked.',
    family: 'validations',
    risk: 'write',
    openWorld: true,
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.sendCepToTelegram(validation_id),
  }),

  define({
    operationId: 'createWebhook',
    title: 'Create a webhook',
    description:
      'Registers an HTTPS endpoint and its events. The signing secret (`attributes.secret`) appears only in this response and enters the conversation: do not repeat it, and store it where the integration reads it.',
    family: 'webhooks',
    risk: 'write',
    openWorld: true,
    inputSchema: createWebhookSchema,
    invoke: (client, args) =>
      client.webhooks.create(args as Parameters<Veriko['webhooks']['create']>[0]),
  }),
  define({
    operationId: 'listWebhooks',
    title: 'List webhooks',
    description: 'Lists the webhook endpoints of the account.',
    family: 'webhooks',
    inputSchema: emptySchema,
    invoke: (client) => client.webhooks.list(),
  }),
  define({
    operationId: 'updateWebhook',
    title: 'Update a webhook',
    description: 'Changes the URL, events, label or status of a webhook. A list in `events` replaces the current one.',
    family: 'webhooks',
    risk: 'write',
    idempotent: true,
    destructive: true,
    openWorld: true,
    inputSchema: updateWebhookSchema,
    invoke(client, { webhook_id, ...changes }) {
      return client.webhooks.update(
        webhook_id,
        changes as Parameters<Veriko['webhooks']['update']>[1],
      );
    },
  }),
  define({
    operationId: 'deleteWebhook',
    title: 'Delete a webhook',
    description: 'Deletes a webhook endpoint and stops its deliveries.',
    family: 'webhooks',
    risk: 'destructive',
    idempotent: true,
    inputSchema: webhookIdSchema,
    confirmation: (args) =>
      `Delete webhook ${args.webhook_id}? Its deliveries stop at once.`,
    invoke: (client, { webhook_id }) => client.webhooks.delete(webhook_id),
  }),
  define({
    operationId: 'sendWebhookTest',
    title: 'Test a webhook',
    description: 'Sends a synthetic `test` event to the endpoint and reports the receiver response.',
    family: 'webhooks',
    risk: 'write',
    openWorld: true,
    inputSchema: webhookIdSchema,
    invoke: (client, { webhook_id }) => client.webhooks.test(webhook_id),
  }),
  define({
    operationId: 'regenerateWebhookSecret',
    title: 'Rotate a webhook secret',
    description:
      'Generates a new signing secret and returns it once (`attributes.secret`; it enters the conversation, so store it and do not repeat it). The previous secret keeps signing for 24 hours (`previous_secret_expires_at`) unless `immediate` is `true`, which revokes it at once: use it when the old secret was exposed.',
    family: 'webhooks',
    risk: 'destructive',
    inputSchema: regenerateWebhookSecretSchema,
    confirmation: (args) =>
      args.immediate === true
        ? `Rotate the signing secret of webhook ${args.webhook_id} and revoke the previous one at once? Receivers still verifying with it fail immediately.`
        : `Rotate the signing secret of webhook ${args.webhook_id}? The previous secret keeps signing for 24 hours. The new secret appears once in the result.`,
    async invoke(client, { webhook_id, immediate }, runtime) {
      if (immediate !== true) return client.webhooks.regenerateSecret(webhook_id);
      const response = await transportOf(client).request({
        method: 'POST',
        path: `/webhooks/${encodeURIComponent(webhook_id)}/regenerate-secret`,
        body: { immediate: true },
        retry: false,
        ...(runtime.signal ? { call: { signal: runtime.signal } } : {}),
      });
      const document = JSON.parse(new TextDecoder().decode(response.body)) as { data?: unknown };
      return document.data ?? document;
    },
  }),
  define({
    operationId: 'listWebhookDeliveries',
    title: 'List webhook deliveries',
    description: 'Lists the delivery attempts of one webhook endpoint, with the receiver response.',
    family: 'webhooks',
    inputSchema: webhookDeliveriesSchema,
    invoke(client, { webhook_id, ...params }) {
      return client.webhooks.deliveries(webhook_id, toSdk(params));
    },
  }),
  define({
    operationId: 'listAllDeliveries',
    title: 'List all deliveries',
    description: 'Lists the deliveries of all webhooks, or of the `endpoint_id` list, with filters.',
    family: 'webhooks',
    inputSchema: allDeliveriesSchema,
    invoke(client, { endpoint_id, ...params }) {
      return endpoint_id
        ? client.webhooks.deliveries(endpoint_id, toSdk(params))
        : client.webhooks.deliveries(toSdk(params));
    },
  }),
  define({
    operationId: 'exportWebhookDeliveries',
    title: 'Export webhook deliveries',
    description: 'Exports the deliveries of one endpoint as a CSV or XLSX file.',
    family: 'webhooks',
    inputSchema: exportWebhookDeliveriesSchema,
    invoke(client, { webhook_id, ...params }) {
      return client.webhooks.exportDeliveries(webhook_id, toSdk(params));
    },
  }),
  define({
    operationId: 'exportAllDeliveries',
    title: 'Export all deliveries',
    description: 'Exports the consolidated deliveries as a CSV or XLSX file.',
    family: 'webhooks',
    inputSchema: exportAllDeliveriesSchema,
    invoke(client, { endpoint_id, ...params }) {
      return endpoint_id
        ? client.webhooks.exportDeliveries(endpoint_id, toSdk(params))
        : client.webhooks.exportDeliveries(toSdk(params));
    },
  }),

  define({
    operationId: 'listBanks',
    title: 'List SPEI banks',
    description:
      'Returns the catalog of SPEI participants with their codes. Public, no API key needed. Send `if_none_match` to avoid downloading it twice.',
    family: 'catalog',
    inputSchema: banksSchema,
    invoke: (client, { if_none_match }) =>
      conditional(
        client.catalog.banks(if_none_match ? { ifNoneMatch: if_none_match } : {}),
        if_none_match,
      ),
  }),
  define({
    operationId: 'lookupBin',
    title: 'Resolve a card BIN',
    description:
      'Identifies the issuing bank from the first 6 to 8 digits of a card. Send only those digits, never the full card number. Public, no API key needed.',
    family: 'catalog',
    inputSchema: binSchema,
    invoke: (client, { bin }) => client.catalog.binLookup(bin),
  }),
  define({
    operationId: 'getSpeiCalendar',
    title: 'Get the SPEI calendar',
    description:
      'Returns the non-business SPEI days of a year and the official provision they come from. A year outside the covered ones answers 404 with `meta.covered_years`. Public, no API key needed.',
    family: 'catalog',
    inputSchema: speiCalendarSchema,
    invoke: (client, { year, if_none_match }) =>
      conditional(
        client.catalog.speiCalendar(year, if_none_match ? { ifNoneMatch: if_none_match } : {}),
        if_none_match,
      ),
  }),
  define({
    operationId: 'banxicoPublicStatus',
    title: 'Get the Banxico status',
    description: 'Returns the public status of the Banxico CEP service. Check it when validations answer `cep_unavailable`.',
    family: 'catalog',
    cost: 'none',
    openWorld: true,
    inputSchema: emptySchema,
    invoke: (client) => client.catalog.banxicoStatus(),
  }),
  define({
    operationId: 'banxicoPublicTimeseries',
    title: 'Get a Banxico time series',
    description: 'Returns a public series of Banxico probe latency or verdicts over a window.',
    family: 'catalog',
    cost: 'none',
    openWorld: true,
    inputSchema: banxicoTimeseriesSchema,
    invoke: (client, args) => client.catalog.banxicoTimeseries(args),
  }),

  define({
    operationId: 'createBeneficiary',
    title: 'Create a beneficiary',
    description:
      'Saves a beneficiary account (CLABE, card or DiMo phone). A phone number needs `bank_code`. If the account was archived, it is reactivated and `reactivated` is `true`.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: createBeneficiarySchema,
    invoke: (client, args) =>
      client.beneficiaries.create({
        ...toSdk(args),
        accountNumber: accountDigits(args.account_number),
      } as Parameters<Veriko['beneficiaries']['create']>[0]),
  }),
  define({
    operationId: 'listBeneficiaries',
    title: 'List beneficiaries',
    description: 'Lists the saved beneficiary accounts. `with_archived: 1` returns only the archived ones.',
    family: 'beneficiaries',
    inputSchema: listBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.list(scope(args, 'with_archived')),
  }),
  define({
    operationId: 'updateBeneficiary',
    title: 'Update a beneficiary',
    description: 'Changes the label, account or bank of a beneficiary. A new account replaces the current one.',
    family: 'beneficiaries',
    risk: 'write',
    idempotent: true,
    destructive: true,
    inputSchema: updateBeneficiarySchema,
    invoke(client, { beneficiary_id, ...changes }) {
      return client.beneficiaries.update(beneficiary_id, {
        ...toSdk(changes, ['account_number']),
        ...(changes.account_number ? { accountNumber: accountDigits(changes.account_number) } : {}),
      } as Parameters<Veriko['beneficiaries']['update']>[1]);
    },
  }),
  define({
    operationId: 'deleteBeneficiary',
    title: 'Archive a beneficiary',
    description: 'Archives a beneficiary account. Creating the same account again reactivates it.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: beneficiaryIdSchema,
    confirmation: (args) =>
      `Archive beneficiary ${args.beneficiary_id}?`,
    invoke: (client, { beneficiary_id }) => client.beneficiaries.delete(beneficiary_id),
  }),
  define({
    operationId: 'lookupBeneficiaryAccount',
    title: 'Look up a beneficiary account',
    description: 'Resolves a full account number (10, 16 or 18 digits) among the saved beneficiaries.',
    family: 'beneficiaries',
    inputSchema: beneficiaryLookupSchema,
    invoke: (client, { account }) => client.beneficiaries.lookup(accountDigits(account)),
  }),
  define({
    operationId: 'validateAccount',
    title: 'Validate an account number',
    description:
      'Checks the CLABE check digit, the card Luhn digit or the phone format, and resolves the bank. It consumes no quota and answers 200 even for a malformed number (`checksum_valid: false`, `account_type: unknown`). Use it to fix an account before spending a validation.',
    family: 'beneficiaries',
    core: true,
    inputSchema: validateAccountSchema,
    invoke: (client, args) => client.beneficiaries.validateAccount(args),
  }),
  define({
    operationId: 'exportBeneficiaries',
    title: 'Export beneficiaries',
    description: 'Exports the beneficiaries as a CSV or XLSX file.',
    family: 'beneficiaries',
    inputSchema: exportBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.export(toSdkScope(args)),
  }),
  define({
    operationId: 'downloadBeneficiaryImportTemplate',
    title: 'Download the beneficiary import template',
    description: 'Downloads the import template with the expected columns, in `csv`, `xlsx`, `xls`, `txt` or `json`.',
    family: 'beneficiaries',
    inputSchema: importTemplateSchema,
    invoke: (client, args) => client.beneficiaries.importTemplate(args),
  }),
  define({
    operationId: 'createBeneficiaryImport',
    title: 'Start a beneficiary import',
    description:
      'Uploads a file (base64, or a path on this computer when the server allows it; up to 20 MB) to prepare an import. Only one job can be open at a time (422 `import_already_in_flight`). Then call `veriko_wait_for_beneficiary_import`, review the preview, and commit.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: createImportSchema,
    localInputSchema: createImportLocalSchema,
    async invoke(client, args, runtime) {
      const { file_base64, filename, parse_mode, file_path } = args as Partial<typeof args> & {
        parse_mode: 'template' | 'free';
        file_path?: string;
      };
      const local = file_path ? await readLocalFile(file_path, runtime.files, IMPORT_RULES) : undefined;
      const content = local?.bytes ?? Buffer.from(file_base64 ?? '', 'base64');
      return client.beneficiaries.importStart(content, {
        filename: filename ?? local?.filename ?? 'import',
        parseMode: parse_mode,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      });
    },
  }),
  define({
    operationId: 'getBeneficiaryImport',
    title: 'Get a beneficiary import',
    description: 'Returns the status and counters of an import job.',
    family: 'beneficiaries',
    inputSchema: importIdSchema,
    invoke: (client, { import_id }) => client.beneficiaries.importStatus(import_id),
  }),
  define({
    operationId: 'waitForBeneficiaryImport',
    helper: true,
    title: 'Wait for a beneficiary import',
    description:
      'Polls an import job until it is `preview_ready` or final (`completed`, `failed`, `cancelled`), for up to `timeout_seconds` (default 25). Returns the last state with `waiting` and `terminal`; when `waiting` is `true`, call it again.',
    family: 'beneficiaries',
    inputSchema: waitForImportSchema,
    invoke: (client, args, runtime) => waitForImport(client, args, runtime),
  }),
  define({
    operationId: 'cancelBeneficiaryImport',
    title: 'Cancel a beneficiary import',
    description: 'Cancels an import that was not committed yet.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: importIdSchema,
    invoke: (client, { import_id }) => client.beneficiaries.importCancel(import_id),
  }),
  define({
    operationId: 'getBeneficiaryImportPreview',
    title: 'Preview a beneficiary import',
    description: 'Lists the classified rows of the import preview (`valid`, `correctable`, `fatal`, duplicates).',
    family: 'beneficiaries',
    inputSchema: importPreviewSchema,
    invoke(client, { import_id, ...params }) {
      return client.beneficiaries.importPreview(import_id, toSdk(params));
    },
  }),
  define({
    operationId: 'patchBeneficiaryImportRow',
    title: 'Fix an import row',
    description: 'Corrects a row of the preview and reprocesses it.',
    family: 'beneficiaries',
    risk: 'write',
    idempotent: true,
    destructive: true,
    inputSchema: editImportRowSchema,
    invoke(client, { import_id, row_id, ...changes }) {
      return client.beneficiaries.importEditRow(import_id, row_id, toSdk(changes));
    },
  }),
  define({
    operationId: 'deleteBeneficiaryImportRow',
    title: 'Remove an import row',
    description: 'Removes a row from the preview.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: importRowSchema,
    confirmation: (args) =>
      `Remove row ${args.row_id} from the preview of import ${args.import_id}?`,
    invoke: (client, { import_id, row_id }) => client.beneficiaries.importRemoveRow(import_id, row_id),
  }),
  define({
    operationId: 'commitBeneficiaryImport',
    title: 'Commit a beneficiary import',
    description:
      'Creates or updates beneficiaries from the valid rows of the preview. It cannot be undone as a batch: review the preview first.',
    family: 'beneficiaries',
    // Gated as destructive because it writes many records at once; the MCP
    // annotation stays `destructiveHint: false` because it deletes nothing.
    risk: 'destructive',
    destructive: false,
    inputSchema: importIdSchema,
    confirmation: (args) =>
      `Commit import ${args.import_id}? It creates or updates beneficiaries from every valid row of the preview and cannot be undone as a batch.`,
    invoke: (client, { import_id }) => client.beneficiaries.importCommit(import_id),
  }),

  define({
    operationId: 'getUsageSummary',
    title: 'Get usage',
    description: 'Returns the quota usage summary of the current period, with the percentage consumed.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.summary(),
  }),
  define({
    operationId: 'getUsageHistory',
    title: 'Get usage history',
    description: 'Returns the monthly usage over recent months, against the current plan cap.',
    family: 'usage',
    inputSchema: usageHistorySchema,
    invoke: (client, args) => client.usage.history(args),
  }),
  define({
    operationId: 'getUsageBreakdown',
    title: 'Break down usage',
    description: 'Breaks down the usage of a period by operation type.',
    family: 'usage',
    inputSchema: usageBreakdownSchema,
    invoke: (client, args) => client.usage.breakdown(args),
  }),
  define({
    operationId: 'getUsageLimits',
    title: 'Get limits',
    description: 'Returns the quota, the limits and the remaining allowance of the account. Read it before validating in bulk.',
    family: 'usage',
    core: true,
    inputSchema: emptySchema,
    invoke: (client) => client.usage.limits(),
  }),
  define({
    operationId: 'getUsageHeatmap',
    title: 'Get the usage heatmap',
    description: 'Returns the daily usage for the requested range.',
    family: 'usage',
    inputSchema: usageHeatmapSchema,
    invoke: (client, args) => client.usage.heatmap(args),
  }),
  define({
    operationId: 'getApiUsage',
    title: 'Get API usage',
    description: 'Returns the recent API activity of the account.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.apiUsage(),
  }),
  define({
    operationId: 'exportApiUsage',
    title: 'Export API usage',
    description: 'Exports the API activity as a CSV or XLSX file.',
    family: 'usage',
    inputSchema: exportUsageSchema,
    invoke: (client, args) => client.usage.export(args),
  }),

  define({
    operationId: 'myProfile',
    title: 'Get my profile',
    description: 'Returns the data of the authenticated integrator: profile, plan, permissions and notification summary.',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.myProfile(),
  }),
  define({
    operationId: 'getMyRetryPolicy',
    title: 'Get the retry policy',
    description: 'Returns the default automatic retry policy of the account and the caps of the plan (`meta.caps`).',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.getMyRetryPolicy(),
  }),
  define({
    operationId: 'updateMyRetryPolicy',
    title: 'Change the retry policy',
    description: 'Replaces the default retry policy of the account. New validations use it unless they send their own `retry_policy`.',
    family: 'account',
    risk: 'write',
    idempotent: true,
    destructive: true,
    idempotencyKey: true,
    inputSchema: updateMyRetryPolicySchema,
    confirmation: (args) =>
      `Replace the default retry policy of the account with ${JSON.stringify(args.retry_policy)}? New validations use it unless they send their own.`,
    invoke: (client, args, runtime) =>
      client.account.updateMyRetryPolicy(args.retry_policy, {
        idempotencyKey: runtime.idempotencyKey,
      }),
  }),
  define({
    operationId: 'getDashboardSummary',
    title: 'Get the dashboard summary',
    description: 'Returns the main indicators of the dashboard and the most recent validations.',
    family: 'dashboard',
    inputSchema: dashboardSchema,
    invoke: (client, args) => client.dashboard.getSummary(args),
  }),
  define({
    operationId: 'listPublicPlans',
    title: 'List public plans',
    description: 'Lists the public plans. No API key needed.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.listPublic(),
  }),
  define({
    operationId: 'getPublicPlanComparison',
    title: 'Compare public plans',
    description: 'Compares the capabilities and prices of the public plans. No API key needed.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.getPublicPlanComparison(),
  }),
  define({
    operationId: 'getUserInsightsOverview',
    title: 'Get the insights overview',
    description: 'Returns aggregated metrics of the account.',
    family: 'insights',
    inputSchema: emptySchema,
    invoke: (client) => client.insights.getOverview(),
  }),
  define({
    operationId: 'getUserInsightsTrends',
    title: 'Get trends',
    description: 'Returns trends of volume or latency over a window.',
    family: 'insights',
    inputSchema: trendsSchema,
    invoke: (client, args) => client.insights.getTrends(args),
  }),
  define({
    operationId: 'getUserInsightsTopBanks',
    title: 'Get top banks',
    description: 'Ranks banks by volume or by error rate.',
    family: 'insights',
    inputSchema: topBanksSchema,
    invoke: (client, args) => client.insights.getTopBanks(args),
  }),
  define({
    operationId: 'getUserInsightsTopBeneficiaries',
    title: 'Get top beneficiaries',
    description: 'Returns the beneficiaries with the most activity.',
    family: 'insights',
    inputSchema: topBeneficiariesSchema,
    invoke: (client, args) => client.insights.getTopBeneficiaries(args),
  }),

  define({
    operationId: 'getFinanceSummary',
    title: 'Get the finance summary',
    description: 'Returns the financial summary of a month.',
    family: 'finance',
    inputSchema: financeSummarySchema,
    invoke: (client, args) => client.finance.getSummary(args),
  }),
  define({
    operationId: 'getFinanceStatement',
    title: 'Download the monthly statement',
    description: 'Generates the monthly statement as a PDF, XLSX, CSV or HTML file.',
    family: 'finance',
    inputSchema: financeStatementSchema,
    invoke: (client, args) => client.finance.getStatement(args),
  }),
  define({
    operationId: 'getFinanceMonthly',
    title: 'Get the monthly movements',
    description: 'Returns the monthly movements: a 20-row structured preview by default, or a file with `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getMonthly(args),
  }),
  define({
    operationId: 'getFinanceCounterparties',
    title: 'Get the counterparties',
    description: 'Returns the counterparties of a month: a 20-row structured preview by default, or a file with `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getCounterparties(args),
  }),
  define({
    operationId: 'getFinanceByBank',
    title: 'Get finance by bank',
    description: 'Returns the month grouped by bank: a 20-row structured preview by default, or a file with `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getByBank(args),
  }),
  define({
    operationId: 'getFinanceAccounting',
    title: 'Get the accounting report',
    description: 'Returns the accounting report of a month: a 20-row preview by default, or a file with `format`. `decimal` picks the separator.',
    family: 'finance',
    inputSchema: financeAccountingSchema,
    invoke: (client, args) => client.finance.getAccounting(args),
  }),
  define({
    operationId: 'getFinanceCeps',
    title: 'Download CEPs by range',
    description: 'Builds a ZIP with the CEPs of a date range and returns it as a file. For large ranges use `veriko_create_finance_cep_export`.',
    family: 'finance',
    inputSchema: financeCepsSchema,
    invoke: (client, args) => client.finance.getCeps(args),
  }),
  define({
    operationId: 'createFinanceCepExport',
    title: 'Request a CEP export',
    description:
      'Requests the ZIP of CEPs of a range to be built in the background (up to 10000). If an export of the same range is already running, it returns that one. Then call `veriko_wait_for_cep_export` and `veriko_download_finance_cep_export`.',
    family: 'finance',
    risk: 'write',
    idempotencyKey: true,
    inputSchema: financeCepExportCreateSchema,
    invoke: (client, args, runtime) =>
      client.finance.createCepExport({
        from: args.from,
        to: args.to,
        idempotencyKey: runtime.idempotencyKey,
      }),
  }),
  define({
    operationId: 'listFinanceCepExports',
    title: 'List CEP exports',
    description: 'Lists the recent CEP exports, newest first.',
    family: 'finance',
    inputSchema: emptySchema,
    invoke: (client) => client.finance.listCepExports(),
  }),
  define({
    operationId: 'getFinanceCepExport',
    title: 'Get a CEP export',
    description: 'Returns the status of a CEP export: `queued`, `building`, `ready`, `failed` or `expired`. With `ready`, the ZIP can be downloaded.',
    family: 'finance',
    inputSchema: financeCepExportIdSchema,
    invoke: (client, { export_id }) => client.finance.getCepExport(export_id),
  }),
  define({
    operationId: 'waitForCepExport',
    helper: true,
    title: 'Wait for a CEP export',
    description:
      'Polls a CEP export until it is `ready`, `failed` or `expired`, for up to `timeout_seconds` (default 25). Returns the last state with `waiting` and `terminal`; when `waiting` is `true`, call it again.',
    family: 'finance',
    inputSchema: waitForCepExportSchema,
    invoke: (client, args, runtime) => waitForCepExport(client, args, runtime),
  }),
  define({
    operationId: 'downloadFinanceCepExport',
    title: 'Download a CEP export',
    description: 'Downloads the ZIP of a CEP export in `ready`. The ZIP comes back as a resource link when it is large.',
    family: 'finance',
    inputSchema: financeCepExportIdSchema,
    invoke: (client, { export_id }) => client.finance.downloadCepExport(export_id),
  }),
  define({
    operationId: 'billingGetSubscription',
    title: 'Get the subscription',
    description: 'Returns the status of the active subscription.',
    family: 'billing',
    inputSchema: emptySchema,
    invoke: (client) => client.billing.getSubscription(),
  }),
] as const;

function toSdkScope(args: Record<string, unknown>): Record<string, unknown> {
  return { ...toSdk(args, ['with_archived']), ...scope(args, 'with_archived') };
}

/** The tools that map to one operation of the public API. */
export const OPERATION_TOOLS: readonly ToolDefinition[] = TOOL_CATALOG.filter((tool) => !tool.helper);

export function selectTools(
  profiles: ReadonlySet<Profile>,
  maxRisk: Risk,
): readonly ToolDefinition[] {
  const all = profiles.has('all');
  return TOOL_CATALOG.filter(
    (tool) =>
      riskAllowed(tool.risk, maxRisk) &&
      (all || profiles.has(tool.family) || (profiles.has('core') && tool.core)),
  );
}
