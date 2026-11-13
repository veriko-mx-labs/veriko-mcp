import { TERMINAL_STATUSES, WEBHOOK_EVENTS } from '@veriko-mx/sdk-runtime';
import { z } from 'zod';

/*
 * Tool inputs use the English field names of the public API, in snake_case, as
 * the API names them on the wire. The adapters in `catalog.ts` map them to the
 * SDK parameters.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.');
const uuid = z.string().uuid();
const speiBankCode = z.string().regex(/^\d{4,5}$/, 'Use a 4 or 5 digit SPEI code.');
const entityId = z.union([z.string().min(1), z.number().int().positive()]);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'The URL must use HTTPS.');
/** The formats of the validation and webhook-delivery exports. */
export const EXPORT_FORMAT_VALUES = ['csv', 'xlsx'] as const;
const format = z.enum(EXPORT_FORMAT_VALUES);
/** CLABE (18 digits), card (16) or DiMo phone (10). Same pattern as the API. */
const account = z.string().regex(/^(?:\d{10}|\d{16}|\d{18})$/, 'Use 10, 16 or 18 digits, with no separators.');
const candidateAccounts = z
  .array(account)
  .min(2)
  .max(10)
  .refine((accounts) => new Set(accounts).size === accounts.length, {
    message: 'Candidate accounts must not repeat.',
  });
const clientRefFilter = z.string().min(1).max(64);
const clientRef = clientRefFilter.regex(
  /^[^\x00-\x1f\x7f]+$/,
  'Do not use line breaks or control characters.',
);

const sensitiveAccountNote =
  'Digits only: the server strips spaces and hyphens, but send them clean.';

export const idempotencyKeyField = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,255}$/, 'Use only A-Z, a-z, 0-9, _ or -.')
  .optional()
  .describe(
    'Optional. Without it each call is a new attempt with a fresh random key. To retry safely after a lost response, send the same key you used the first time: within 24 hours the API replays the stored response (`idempotent_replayed: true`) and does not run the operation again. Reusing a key with a different body returns 422 `idempotency_key_reused`.',
  );

function base64Bytes(maxBytes: number, label: string) {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  return z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (value.length % 4 !== 0) {
        context.addIssue({ code: 'custom', message: 'Invalid base64.' });
        return;
      }
      if (value.length > maxEncodedLength) {
        context.addIssue({
          code: 'custom',
          message: `${label} exceeds the ${maxBytes / (1024 * 1024)} MB limit.`,
        });
        return;
      }
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value) {
        context.addIssue({ code: 'custom', message: 'Invalid base64.' });
        return;
      }
      if (decoded.byteLength > maxBytes) {
        context.addIssue({
          code: 'custom',
          message: `${label} exceeds the ${maxBytes / (1024 * 1024)} MB limit.`,
        });
      }
    });
}

const ocrImageBase64 = base64Bytes(12 * 1024 * 1024, 'The image');
const beneficiaryImportBase64 = base64Bytes(20 * 1024 * 1024, 'The file');

export const emptySchema = z.object({}).strict();

export const retryPolicySchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe('`true` turns automatic retries on. With `false` the other fields are ignored.'),
    max_retries: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum retries, at least 1. The plan caps it (free 1, personal 3, business 5, enterprise 10, volume 20); above the cap the API answers 422 `retry_policy_invalid`. `veriko_get_my_retry_policy` returns the cap in `meta.caps`.',
      ),
    interval_seconds: z
      .number()
      .int()
      .min(300)
      .max(86_400)
      .optional()
      .describe('Seconds between retries, from 300 (5 minutes) to 86400 (24 hours).'),
    outcomes: z
      .array(z.enum(['not_found', 'cep_unavailable', 'error']))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Outcomes must not repeat.',
      })
      .optional()
      .describe('Outcomes that trigger a retry. Retries consume no quota.'),
  })
  .strict()
  .describe(
    'Automatic retry policy. Omit it to use the account policy (`veriko_get_my_retry_policy`).',
  );

const asyncField = z
  .boolean()
  .default(false)
  .describe(
    '`true` enqueues the validation and answers at once with `status: queued` and the `id`; then call `veriko_wait_for_validation`. With `false` the call waits up to 45 seconds for Banxico and, past that, answers `processing` with `meta.async_reason: sync_deadline`. Either way the validation consumes quota.',
  );

const accountPairRules = {
  both: 'Send `beneficiary_account` or `candidate_accounts`, not both.',
} as const;

export const validateDirectSchema = z
  .object({
    send_date: date
      .optional()
      .describe(
        'Date the transfer was sent, `YYYY-MM-DD`. Banxico uses it to locate the CEP; it can differ from the operation day the CEP prints. Optional: without it the API tries candidate dates, and answers 422 only when it has nothing to infer from.',
      ),
    amount: z
      .union([
        z.number().positive().max(9_999_999_999_999.99),
        z.string().regex(/^\d{1,13}(?:\.\d{1,2})?$/),
      ])
      .describe(
        'Amount in Mexican pesos (MXN), greater than zero, up to two decimals and 13 integer digits. A string such as `"1500.50"` is accepted; do not use scientific notation.',
      ),
    tracking_key: z
      .string()
      .min(1)
      .max(30)
      .optional()
      .describe(
        'SPEI tracking key (1 to 30 characters). Send `tracking_key` or `numeric_reference`. With both, the query goes by tracking key only.',
      ),
    numeric_reference: z
      .string()
      .regex(/^\d{1,7}$/)
      .optional()
      .describe('Numeric reference, 1 to 7 digits. Required when `tracking_key` is missing.'),
    beneficiary_account: account
      .optional()
      .describe(
        `Receiving account: CLABE (18 digits), card (16) or DiMo phone (10). ${accountPairRules.both} ${sensitiveAccountNote}`,
      ),
    candidate_accounts: candidateAccounts
      .optional()
      .describe(
        'Two or more accounts, one of which received the transfer, when it is not known which. The service allows 3 by default (a larger list answers 422 with `meta.max`), never more than 10. One quota unit regardless of the count; `attributes.candidate_match` reports which matched. Replaces `beneficiary_account`.',
      ),
    sender_bank: z
      .string()
      .max(255)
      .optional()
      .describe(
        'Sender bank, SPEI name or code. When missing or wrong, the tracking key can supply it.',
      ),
    receiver_bank: z
      .string()
      .max(255)
      .optional()
      .describe(
        'Receiver bank, SPEI name or code. Optional when it can be derived from `beneficiary_account`.',
      ),
    recipient_is_bank: z
      .boolean()
      .optional()
      .describe(
        '`true` when the payee is the receiving institution itself ("Pago a Banco" on the Banxico CEP): credit card, loan or service payments. `false` for a transfer to an account holder (default).',
      ),
    retry_policy: retryPolicySchema.optional(),
    client_ref: clientRef
      .optional()
      .describe(
        'Your own reference, 1 to 64 characters, no line breaks. It comes back on the validation and in webhooks, and filters `veriko_list_validations`.',
      ),
    idempotency_key: idempotencyKeyField,
    async: asyncField,
  })
  .strict()
  .refine((value) => value.tracking_key || value.numeric_reference, {
    message: 'Send tracking_key or numeric_reference.',
  })
  .refine(
    (value) => (value.beneficiary_account === undefined) !== (value.candidate_accounts === undefined),
    { message: 'Send beneficiary_account or candidate_accounts, and not both.' },
  );

const validateOcrShape = {
    image_base64: ocrImageBase64
      .optional()
      .describe(
        'Receipt as base64: JPEG, PNG, WebP, or a PDF of 1 to 3 pages, up to 12 MB. Large for a model to emit; prefer `image_url`. If both are sent, only `image_url` is used.',
      ),
    image_url: httpsUrl
      .optional()
      .describe('Public HTTPS URL of the receipt, same formats and 12 MB limit. `http` URLs are rejected.'),
    beneficiary_account: account
      .optional()
      .describe(
        `Receiving account, useful when the receipt omits it or shows it incomplete. Required for DiMo phones. ${accountPairRules.both}`,
      ),
    candidate_accounts: candidateAccounts
      .optional()
      .describe(
        'Two or more accounts, one of which received the transfer, when the receipt does not show it. Same rules as in `veriko_validate_direct`.',
      ),
    sender_bank: speiBankCode
      .optional()
      .describe('SPEI code of the sender bank, to correct the one read from the receipt, for example `40012`.'),
    receiver_bank: speiBankCode
      .optional()
      .describe('SPEI code of the receiver bank, to correct the one read from the receipt, for example `40002`.'),
    recipient_is_bank: z
      .boolean()
      .optional()
      .describe(
        '`true` when the payee is the receiving institution itself ("Pago a Banco" on the Banxico CEP), such as credit card or loan payments. Default `false`.',
      ),
    retry_policy: retryPolicySchema.optional(),
    client_ref: clientRef
      .optional()
      .describe('Your own reference, 1 to 64 characters. It comes back on the validation and in webhooks.'),
    retain_image: z
      .boolean()
      .optional()
      .describe(
        'Default `true`: the API keeps the receipt (`veriko_get_validation_image`). With `false` it deletes the file once the validation reaches a final state.',
      ),
    idempotency_key: idempotencyKeyField,
    async: asyncField,
};

const OCR_ACCOUNT_RULE = { message: 'Send beneficiary_account or candidate_accounts, not both.' };
const noPairedAccounts = (value: { beneficiary_account?: unknown; candidate_accounts?: unknown }) =>
  value.beneficiary_account === undefined || value.candidate_accounts === undefined;

export const validateOcrSchema = z
  .object(validateOcrShape)
  .strict()
  .refine((value) => value.image_base64 || value.image_url, {
    message: 'Send image_base64 or image_url.',
  })
  .refine(noPairedAccounts, OCR_ACCOUNT_RULE);

/**
 * The same tool when the server may read local files (stdio, `VERIKO_MCP_FILE_ROOTS`):
 * the receipt can also come from `image_path`. The HTTP server never advertises it.
 */
export const validateOcrLocalSchema = z
  .object({
    ...validateOcrShape,
    image_path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Absolute path of a receipt on this computer: JPEG, PNG, WebP or a PDF of 1 to 3 pages, up to 12 MB, inside a directory the server allows. Prefer it to `image_base64`; send one of `image_path`, `image_url` or `image_base64`.',
      ),
  })
  .strict()
  .refine(
    (value) => [value.image_path, value.image_url, value.image_base64].filter(Boolean).length === 1,
    { message: 'Send exactly one of image_path, image_url or image_base64.' },
  )
  .refine(noPairedAccounts, OCR_ACCOUNT_RULE);

export const VALIDATION_STATUSES = [
  'queued',
  'processing',
  'valid',
  'not_found',
  'cep_unavailable',
  'invalid',
  'returned',
  'failed',
  'error',
] as const;
const validationStatus = z.enum(VALIDATION_STATUSES);

const withdrawnScope = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe(
    'Withdrawn validations (`veriko_delete_validation`). Omit to include active and withdrawn; `0` returns only active ones; `1` returns only withdrawn ones. Note that `1` is not "include withdrawn".',
  );

export const validationFiltersShape = {
  status: z
    .union([validationStatus, z.array(validationStatus).min(1)])
    .optional()
    .describe(
      'Lifecycle state, one value or a list: queued, processing, valid, not_found, cep_unavailable, invalid, returned, failed, error.',
    ),
  type: z.enum(['direct', 'ocr']).optional().describe('`direct` for field validations, `ocr` for receipt images.'),
  from: date.optional().describe('Start date (inclusive, `YYYY-MM-DD`), applied to the creation date.'),
  to: date.optional().describe('End date (inclusive, `YYYY-MM-DD`), applied to the creation date.'),
  search: z
    .string()
    .max(100)
    .optional()
    .describe('Case-insensitive text searched in the submitted, normalized and Banxico data. `%` and `_` are literal.'),
  playground: z.literal(true).optional().describe('`true` shows only Playground (test bench) validations.'),
  with_deleted: withdrawnScope,
  batch_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Identifier of the import job that created the validations.'),
  bank: z
    .string()
    .regex(/^\d{1,5}$/)
    .optional()
    .describe('SPEI code (1 to 5 digits) of the sender or receiver bank of the original request.'),
  banks: z
    .union([
      z.string().regex(/^\d{1,5}(,\d{1,5}){0,49}$/),
      z.array(z.string().regex(/^\d{1,5}$/)).min(1).max(50),
    ])
    .optional()
    .describe('Up to 50 SPEI codes, as a list or comma-separated; matches any of them as sender or receiver.'),
  amount_min: z.number().nonnegative().optional().describe('Minimum amount, inclusive.'),
  amount_max: z.number().nonnegative().optional().describe('Maximum amount, inclusive.'),
  client_ref: clientRefFilter.optional().describe('Exact match with the `client_ref` sent when validating. Case and accent sensitive.'),
  retry_state: z
    .enum(['pending', 'resolved', 'exhausted', 'cancelled'])
    .optional()
    .describe('State of the automatic retry cycle.'),
} as const;

export const listValidationsSchema = z
  .object({
    ...validationFiltersShape,
    page: z.number().int().positive().optional().describe('Page, starting at 1. Default 1.'),
    per_page: z.number().int().min(1).max(50).optional().describe('Rows per page, 1 to 50. Default 10.'),
  })
  .strict();
export const validationFiltersSchema = z.object(validationFiltersShape).strict();
export const exportValidationsSchema = z
  .object({
    ...validationFiltersShape,
    format: format.optional().describe('`csv` (default) or `xlsx`.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Maximum rows. It only lowers the general cap of 100000.'),
  })
  .strict();

const validationIdField = uuid.describe('Validation identifier (UUID).');
const ifNoneMatch = z
  .string()
  .optional()
  .describe(
    '`ETag` from an earlier response, sent back as is. If nothing changed the result is `{ not_modified: true }`, which is a success, not an error.',
  );

export const validationIdSchema = z.object({ validation_id: validationIdField }).strict();
export const getValidationSchema = z
  .object({ validation_id: validationIdField, if_none_match: ifNoneMatch })
  .strict();
export const downloadCepSchema = z
  .object({
    validation_id: validationIdField,
    format: z.enum(['xml', 'pdf']).default('xml').describe('`xml` (default, the Banxico original) or `pdf`.'),
  })
  .strict();
export const validationRetryPolicySchema = z
  .object({
    validation_id: validationIdField,
    retry_policy: retryPolicySchema,
    idempotency_key: idempotencyKeyField,
  })
  .strict();
export const validationIdempotentSchema = z
  .object({ validation_id: validationIdField, idempotency_key: idempotencyKeyField })
  .strict();

const webhookEvents = z.enum(WEBHOOK_EVENTS);
const deliveryEvent = z.union([webhookEvents, z.literal('test')]);
const deliveryStatus = z.enum(['success', 'failed', 'retrying', 'pending']);
const webhookIdField = uuid.describe('Webhook endpoint identifier (UUID).');

export const createWebhookSchema = z
  .object({
    url: httpsUrl
      .max(2048)
      .describe('Receiving HTTPS URL, up to 2048 characters. Rejected if it resolves to a private address.'),
    events: z
      .array(webhookEvents)
      .min(1)
      .max(10)
      .describe('Events to subscribe to, 1 to 10.'),
    description: z.string().max(255).nullable().optional().describe('Free label, up to 255 characters. `null` clears it.'),
  })
  .strict();
export const webhookIdSchema = z.object({ webhook_id: webhookIdField }).strict();
export const regenerateWebhookSecretSchema = z
  .object({
    webhook_id: webhookIdField,
    immediate: z
      .boolean()
      .optional()
      .describe(
        '`true` revokes the previous secret at once. Default `false`: the previous secret keeps signing for 24 hours (`previous_secret_expires_at`). Use `true` when the old secret was exposed.',
      ),
  })
  .strict();
export const updateWebhookSchema = z
  .object({
    webhook_id: webhookIdField,
    url: httpsUrl.max(2048).optional().describe('New receiving HTTPS URL, up to 2048 characters.'),
    events: z.array(webhookEvents).min(1).max(10).optional().describe('New event list, 1 to 10. It replaces the current one.'),
    description: z.string().max(255).nullable().optional().describe('New label. `null` removes it.'),
    status: z.enum(['active', 'disabled']).optional().describe('`active` receives deliveries; `disabled` stops them.'),
  })
  .strict()
  .refine(
    ({ webhook_id: _webhookId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Specify at least one change.' },
  );
const responseStatus = z.union([
  z.number().int().min(100).max(599),
  z.string().regex(/^([1-5][0-9]{2}|[1-5]xx|none)$/),
]);
const deliveryFiltersShape = {
  status: z
    .union([deliveryStatus, z.array(deliveryStatus).min(1)])
    .optional()
    .describe('Delivery state: success, failed, retrying or pending.'),
  event_type: z
    .union([deliveryEvent, z.array(deliveryEvent).min(1)])
    .optional()
    .describe('Event type, or `test` for synthetic deliveries.'),
  response_status: z
    .union([responseStatus, z.array(responseStatus).min(1).max(20)])
    .optional()
    .describe('HTTP status the receiver answered: an exact code (`404`), a family (`2xx`) or `none` for no response. Up to 20.'),
  validation_id: uuid.optional().describe('Only deliveries of this validation.'),
  q: z.string().max(100).optional().describe('Text searched in delivery id, endpoint URL and description, event type and validation id.'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
    .optional()
    .describe('Deliveries created from this moment: `YYYY-MM-DD` (midnight UTC) or ISO 8601 date-time with offset.'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
    .optional()
    .describe('Deliveries created until this moment: `YYYY-MM-DD` (end of that day, UTC) or ISO 8601 date-time.'),
  min_attempt: z.number().int().min(1).max(255).optional().describe('Only deliveries at this attempt number or later. `2` keeps the retried ones.'),
  min_response_time_ms: z.number().int().min(0).max(600_000).optional().describe('Only deliveries whose receiver took at least this many milliseconds.'),
} as const;
const deliveriesShape = {
  page: z.number().int().positive().optional().describe('Page, starting at 1.'),
  per_page: z.number().int().min(1).max(100).optional().describe('Deliveries per page, 1 to 100. Default 50.'),
  ...deliveryFiltersShape,
} as const;
const endpointIds = z
  .array(uuid)
  .min(1)
  .max(20)
  .describe('Restrict to these webhook endpoints (UUIDs), up to 20. Omit for all endpoints.');
export const webhookDeliveriesSchema = z
  .object({ webhook_id: webhookIdField, ...deliveriesShape })
  .strict();
export const allDeliveriesSchema = z
  .object({ endpoint_id: endpointIds.optional(), ...deliveriesShape })
  .strict();
const exportDeliveriesShape = {
  format: format.optional().describe('`csv` (default) or `xlsx`.'),
  limit: z.number().int().min(1).max(100_000).optional().describe('Maximum rows. It only lowers the general cap of 100000.'),
  ...deliveryFiltersShape,
} as const;
export const exportWebhookDeliveriesSchema = z
  .object({ webhook_id: webhookIdField, ...exportDeliveriesShape })
  .strict();
export const exportAllDeliveriesSchema = z
  .object({ endpoint_id: endpointIds.optional(), ...exportDeliveriesShape })
  .strict();

export const banksSchema = z.object({ if_none_match: ifNoneMatch }).strict();
export const binSchema = z
  .object({
    bin: z
      .string()
      .regex(/^\d{6,8}$/)
      .describe('First 6 to 8 digits of the card. Never send the full card number.'),
  })
  .strict();
export const speiCalendarSchema = z
  .object({
    year: z.number().int().min(1000).max(9999).describe('Four-digit calendar year.'),
    if_none_match: ifNoneMatch,
  })
  .strict();
export const banxicoTimeseriesSchema = z
  .object({
    metric: z
      .enum(['probe_latency', 'verdict'])
      .optional()
      .describe('`probe_latency` (default): average latency in milliseconds; `verdict`: Banxico verdicts over time.'),
    window: z
      .enum(['1h', '8h', '12h', '24h', '7d'])
      .optional()
      .describe('Window covered, default `24h`. `1h` groups by minute, the rest by hour.'),
  })
  .strict();

const beneficiaryIdField = entityId.describe('Numeric beneficiary identifier.');
export const digitsOf = (value: string): string => value.replace(/[ -]/g, '');
const accountNumber = z
  .string()
  .regex(/^[0-9 -]{10,40}$/, 'Use digits, with optional spaces or hyphens.')
  .refine((value) => /^\d{10,19}$/.test(digitsOf(value)), 'Use 10 to 19 digits.');
const bankCode = z.string().regex(/^\d{4,5}$/).describe('SPEI bank code (4 or 5 digits). Required for a 10-digit phone number; ignored for CLABE and cards.');
const withArchived = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe('Archived accounts. Omit for all; `0` returns only active accounts; `1` returns only archived ones.');

export const beneficiaryIdSchema = z.object({ beneficiary_id: beneficiaryIdField }).strict();
export const createBeneficiarySchema = z
  .object({
    account_number: accountNumber.describe(
      'CLABE (18 digits), card (16) or DiMo phone (10). Spaces and hyphens are removed.',
    ),
    bank_code: bankCode.optional(),
    label: z.string().max(100).optional().describe('Label that identifies the account in the list, up to 100 characters.'),
  })
  .strict()
  .refine((value) => digitsOf(value.account_number).length !== 10 || value.bank_code !== undefined, {
    message: 'A 10-digit phone number requires bank_code.',
    path: ['bank_code'],
  });
export const updateBeneficiarySchema = z
  .object({
    beneficiary_id: beneficiaryIdField,
    label: z.string().max(100).optional().describe('New label, up to 100 characters.'),
    account_number: accountNumber
      .optional()
      .describe('New account number. It replaces the current one and re-derives type and bank. For a phone, send `bank_code` too.'),
    bank_code: bankCode.optional(),
  })
  .strict()
  .refine(
    ({ beneficiary_id: _beneficiaryId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Specify at least one change.' },
  )
  .refine((value) => (value.account_number === undefined || digitsOf(value.account_number).length !== 10) || value.bank_code !== undefined, {
    message: 'A 10-digit phone number requires bank_code.',
    path: ['bank_code'],
  });
export const listBeneficiariesSchema = z.object({ with_archived: withArchived }).strict();
export const beneficiaryLookupSchema = z
  .object({
    account: accountNumber.describe('Full account: 10 digits (phone), 16 (card) or 18 (CLABE).'),
  })
  .strict();
export const validateAccountSchema = z
  .object({
    account: z
      .string()
      .regex(/^\d{1,19}$/)
      .describe('Account digits, complete or partial: CLABE, card or phone, 1 to 19 digits.'),
    type: z
      .enum(['clabe', 'bin'])
      .optional()
      .describe(
        'Forces the interpretation instead of detecting it by length. `clabe` resolves the bank by prefix even if the CLABE is incomplete; `bin` treats the input as a card BIN.',
      ),
  })
  .strict();
export const exportBeneficiariesSchema = z
  .object({
    format: format.optional().describe('`csv` (default) or `xlsx`.'),
    with_archived: withArchived,
    limit: z.number().int().min(1).max(100_000).optional().describe('Maximum rows. It only lowers the general cap of 100000.'),
  })
  .strict();
export const importTemplateSchema = z
  .object({
    format: z.enum(['csv', 'xlsx', 'xls', 'txt', 'json']).describe('Template format. `json` has the same shape as the file the import reads.'),
  })
  .strict();
export const createImportSchema = z
  .object({
    file_base64: beneficiaryImportBase64.describe('File content as base64, up to 20 MB: CSV, XLS, XLSX, TXT, JSON or PDF.'),
    filename: z
      .string()
      .min(1)
      .max(255)
      .describe('File name with its extension (`.csv`, `.xlsx`...). The extension tells the API the format.'),
    parse_mode: z
      .enum(['template', 'free'])
      .default('template')
      .describe('`template` expects the canonical headers; `free` lets the service infer the structure.'),
  })
  .strict();
const importParseMode = z
  .enum(['template', 'free'])
  .default('template')
  .describe('`template` expects the canonical headers; `free` lets the service infer the structure.');

/**
 * The same tool when the server may read local files (stdio, `VERIKO_MCP_FILE_ROOTS`):
 * the file can also come from `file_path`, and `filename` then defaults to its name.
 */
export const createImportLocalSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Absolute path of the file on this computer, up to 20 MB, inside a directory the server allows: CSV, XLS, XLSX, TXT, JSON or PDF. Prefer it to `file_base64`. `filename` defaults to the file name.',
      ),
    file_base64: beneficiaryImportBase64
      .optional()
      .describe('File content as base64, up to 20 MB. Send it or `file_path`, not both.'),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('File name with its extension (`.csv`, `.xlsx`...). Required with `file_base64`.'),
    parse_mode: importParseMode,
  })
  .strict()
  .refine((value) => (value.file_path === undefined) !== (value.file_base64 === undefined), {
    message: 'Send exactly one of file_path or file_base64.',
  })
  .refine((value) => value.file_path !== undefined || value.filename !== undefined, {
    message: 'Send filename with file_base64.',
  });

const importIdField = entityId.describe('Numeric import job identifier.');
export const importIdSchema = z.object({ import_id: importIdField }).strict();
export const importPreviewSchema = z
  .object({
    import_id: importIdField,
    page: z.number().int().positive().optional().describe('Page, starting at 1.'),
    per_page: z.number().int().min(1).max(100).optional().describe('Rows per page, 1 to 100. Default 25.'),
    buckets: z
      .array(z.enum(['valid', 'correctable', 'fatal', 'duplicate_account', 'duplicate_alias']))
      .min(1)
      .optional()
      .describe('Row classes to include: `valid` is saved as is, `correctable` needs a fix (`veriko_patch_beneficiary_import_row`), `fatal` cannot be saved, the duplicates collide with existing accounts or labels.'),
  })
  .strict();
export const editImportRowSchema = z
  .object({
    import_id: importIdField,
    row_id: entityId.describe('Numeric row identifier within the import.'),
    parsed_account: z
      .string()
      .max(32)
      .regex(/^[0-9 -]{0,32}$/)
      .optional()
      .describe('Corrected account number, up to 32 characters of digits. It is normalized again on reprocessing.'),
    parsed_label: z.string().max(100).optional().describe('Corrected label. A leading `=`, `+`, `-` or `@` is stored with an apostrophe so spreadsheets do not read it as a formula.'),
    parsed_account_type: z.enum(['clabe', 'card', 'phone']).optional().describe('Corrected account type.'),
    parsed_bank_code: z.string().regex(/^\d{4,5}$/).optional().describe('Corrected SPEI bank code, useful for phone accounts.'),
    parsed_bank_name: z.string().max(50).optional().describe('Corrected bank name.'),
  })
  .strict()
  .refine(
    ({ import_id: _importId, row_id: _rowId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Specify at least one correction.' },
  );
export const importRowSchema = z
  .object({ import_id: importIdField, row_id: entityId.describe('Numeric row identifier within the import.') })
  .strict();

export const usageHistorySchema = z
  .object({ months: z.number().int().min(1).max(24).optional().describe('Months to include, backwards from now. Default 6.') })
  .strict();
export const usageBreakdownSchema = z
  .object({
    period: z
      .union([z.literal('current'), month])
      .optional()
      .describe('`current` for the running month, or `YYYY-MM`.'),
  })
  .strict();
export const usageHeatmapSchema = z
  .object({ days: z.number().int().min(1).max(90).optional().describe('Days to include. Default 30.') })
  .strict();
export const exportUsageSchema = z
  .object({
    format: format.optional().describe('`csv` (default) or `xlsx`.'),
    from: date.optional().describe('Start date (inclusive, `YYYY-MM-DD`).'),
    to: date.optional().describe('End date (inclusive, `YYYY-MM-DD`).'),
    limit: z.number().int().min(1).optional().describe('Maximum rows. It only lowers the default cap of 100000.'),
  })
  .strict();
export const updateMyRetryPolicySchema = z
  .object({ retry_policy: retryPolicySchema, idempotency_key: idempotencyKeyField })
  .strict();
export const dashboardSchema = z
  .object({ limit: z.number().int().min(1).max(10).optional().describe('Recent validations to return, 1 to 10. Default 5.') })
  .strict();
export const trendsSchema = z
  .object({
    range: z.enum(['24h', '7d', '30d', '90d']).optional().describe('Window of the series. Default `7d`.'),
    metric: z.enum(['volume', 'latency']).optional().describe('`volume` (default) counts validations; `latency` returns processing-time percentiles.'),
  })
  .strict();
export const topBanksSchema = z
  .object({
    metric: z.enum(['volume', 'errors']).optional().describe('Sort by `volume` (default) or by error rate (`errors`).'),
    limit: z.number().int().positive().max(50).optional().describe('Maximum banks, up to 50. Default 10.'),
  })
  .strict();
export const topBeneficiariesSchema = z
  .object({ limit: z.number().int().positive().max(50).optional().describe('Maximum beneficiaries, up to 50. Default 10.') })
  .strict();

const financeMonth = month.describe('Month to report, `YYYY-MM`.');
const financeBase = { month: financeMonth } as const;
const financeLimit = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .optional()
  .describe('Row cap for `csv` and `xlsx`. It does not apply to the PDF, which has its own cap of 1000 rows.');
export const financeSummarySchema = z.object(financeBase).strict();
export const financeStatementSchema = z
  .object({
    ...financeBase,
    format: z.enum(['pdf', 'xlsx', 'csv', 'html']).default('pdf').describe('File format. Default `pdf`.'),
  })
  .strict();
export const financePreviewSchema = z
  .object({
    ...financeBase,
    format: z
      .enum(['csv', 'xlsx', 'pdf', 'preview'])
      .default('preview')
      .describe('`preview` (default here) returns the first 20 rows as structured data; `csv`, `xlsx` and `pdf` return a file.'),
    limit: financeLimit,
  })
  .strict();
export const financeAccountingSchema = z
  .object({
    ...financeBase,
    format: z
      .enum(['csv', 'xlsx', 'pdf', 'preview'])
      .default('preview')
      .describe('`preview` (default here) returns the first 20 rows as structured data; `csv`, `xlsx` and `pdf` return a file.'),
    limit: financeLimit,
    decimal: z
      .enum(['comma', 'dot'])
      .optional()
      .describe('Decimal separator: `comma` (default, `1.234,56`) or `dot` (`1,234.56`).'),
  })
  .strict();
const rangeFrom = date.describe('Start date (inclusive, `YYYY-MM-DD`).');
const rangeTo = date.describe('End date (inclusive, `YYYY-MM-DD`). Must not be before `from`.');
export const financeCepsSchema = z.object({ from: rangeFrom, to: rangeTo }).strict();
export const financeCepExportCreateSchema = z
  .object({ from: rangeFrom, to: rangeTo, idempotency_key: idempotencyKeyField })
  .strict();
export const financeCepExportIdSchema = z
  .object({ export_id: uuid.describe('CEP export identifier (UUID).') })
  .strict();

const timeoutSeconds = z
  .number()
  .int()
  .min(1)
  .max(40)
  .optional()
  .describe(
    'Longest wait of this call, in seconds, 1 to 40. Default 25. If the resource is not final by then, the result says `waiting: true`; call the tool again.',
  );
export const waitForValidationSchema = z
  .object({ validation_id: validationIdField, timeout_seconds: timeoutSeconds })
  .strict();
export const waitForCepExportSchema = z
  .object({ export_id: z.string().uuid().describe('CEP export identifier (UUID).'), timeout_seconds: timeoutSeconds })
  .strict();
export const waitForImportSchema = z
  .object({ import_id: importIdField, timeout_seconds: timeoutSeconds })
  .strict();

/** The states after which a validation stops being polled (the spec's `x-terminal-values`). */
export const VALIDATION_TERMINAL_STATUSES: readonly string[] = TERMINAL_STATUSES;
/** The export states after which polling stops (the spec's `x-terminal-values`). */
export const CEP_EXPORT_TERMINAL_STATUSES = ['ready', 'failed', 'expired'] as const;
