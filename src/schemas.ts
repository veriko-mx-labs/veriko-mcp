import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa YYYY-MM-DD.');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Usa YYYY-MM.');
const uuid = z.string().uuid();
const entityId = z.union([z.string().min(1), z.number().int().positive()]);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'La URL debe usar HTTPS.');
const format = z.enum(['csv', 'xlsx']);
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,255}$/, 'Usa sólo A-Z, a-z, 0-9, _ o -.')
  .optional();

function base64Bytes(maxBytes: number, label: string) {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  return z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (value.length % 4 !== 0) {
        context.addIssue({ code: 'custom', message: 'Base64 inválido.' });
        return;
      }
      if (value.length > maxEncodedLength) {
        context.addIssue({
          code: 'custom',
          message: `${label} supera el límite de ${maxBytes / (1024 * 1024)} MB.`,
        });
        return;
      }
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value) {
        context.addIssue({ code: 'custom', message: 'Base64 inválido.' });
        return;
      }
      if (decoded.byteLength > maxBytes) {
        context.addIssue({
          code: 'custom',
          message: `${label} supera el límite de ${maxBytes / (1024 * 1024)} MB.`,
        });
      }
    });
}

const ocrImageBase64 = base64Bytes(12 * 1024 * 1024, 'La imagen');
const beneficiaryImportBase64 = base64Bytes(20 * 1024 * 1024, 'El archivo');

export const emptySchema = z.object({}).strict();

export const retryPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    max_retries: z.number().int().nonnegative().optional(),
    interval_seconds: z.number().int().min(300).max(86_400).optional(),
    outcomes: z.array(z.enum(['not_found', 'cep_unavailable', 'error'])).min(1).optional(),
  })
  .strict();

export const validateDirectSchema = z
  .object({
    fecha: date,
    monto: z.union([z.number().positive(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)]),
    claveRastreo: z.string().min(1).max(30).optional(),
    referenciaNumerica: z.string().regex(/^\d{1,7}$/).optional(),
    cuentaBeneficiaria: z.string().optional(),
    emisor: z.string().optional(),
    receptor: z.string().optional(),
    receptorParticipante: z.union([z.literal(0), z.literal(1)]).optional(),
    retryPolicy: retryPolicySchema.optional(),
    idempotencyKey,
    async: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.claveRastreo || value.referenciaNumerica, {
    message: 'Se requiere claveRastreo o referenciaNumerica.',
  });

export const validateOcrSchema = z
  .object({
    imageBase64: ocrImageBase64.optional(),
    imageUrl: httpsUrl.optional(),
    cuentaBeneficiaria: z.string().optional(),
    retryPolicy: retryPolicySchema.optional(),
    idempotencyKey,
    async: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.imageBase64 || value.imageUrl, {
    message: 'Se requiere imageBase64 o imageUrl.',
  });

export const validationFiltersShape = {
  status: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  type: z.enum(['direct', 'ocr']).optional(),
  from: date.optional(),
  to: date.optional(),
  search: z.string().optional(),
  playground: z.literal(true).optional(),
  withDeleted: z.boolean().optional(),
  batchId: z.number().int().positive().optional(),
  bank: z.string().optional(),
  amountMin: z.number().nonnegative().optional(),
  amountMax: z.number().nonnegative().optional(),
  retryState: z.enum(['pending', 'resolved', 'exhausted', 'cancelled']).optional(),
} as const;

export const listValidationsSchema = z
  .object({
    ...validationFiltersShape,
    page: z.number().int().positive().optional(),
    perPage: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const validationFiltersSchema = z.object(validationFiltersShape).strict();
export const exportValidationsSchema = z
  .object({
    ...validationFiltersShape,
    format: format.optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

export const validationIdSchema = z.object({ validationId: uuid }).strict();
export const getValidationSchema = z
  .object({ validationId: uuid, ifNoneMatch: z.string().optional() })
  .strict();
export const downloadCepSchema = z
  .object({ validationId: uuid, format: z.enum(['xml', 'pdf']).default('xml') })
  .strict();
export const validationRetryPolicySchema = z
  .object({ validationId: uuid, policy: retryPolicySchema, idempotencyKey })
  .strict();
export const validationIdempotentSchema = z
  .object({ validationId: uuid, idempotencyKey })
  .strict();

const webhookEvents = z.enum([
  'validation.completed',
  'validation.failed',
  'validation.error',
  'validation.retry.scheduled',
  'validation.retry.resolved',
  'validation.retry.exhausted',
  'billing.payment_succeeded',
  'billing.payment_failed',
  'billing.trial_will_end',
  'billing.subscription_canceled',
  'billing.invoice_upcoming',
]);
const deliveryEvent = z.union([webhookEvents, z.literal('test')]);
const deliveryStatus = z.enum(['success', 'failed', 'retrying', 'pending']);

export const createWebhookSchema = z
  .object({
    url: httpsUrl.max(2048),
    events: z.array(webhookEvents).min(1).max(10),
    description: z.string().optional(),
  })
  .strict();
export const webhookIdSchema = z.object({ webhookId: uuid }).strict();
export const updateWebhookSchema = z
  .object({
    webhookId: uuid,
    url: httpsUrl.max(2048).optional(),
    events: z.array(webhookEvents).min(1).max(10).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine(
    ({ webhookId: _webhookId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos un cambio.' },
  );
const deliveriesShape = {
  page: z.number().int().positive().optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  status: deliveryStatus.optional(),
  eventType: deliveryEvent.optional(),
} as const;
export const webhookDeliveriesSchema = z
  .object({ webhookId: uuid, ...deliveriesShape })
  .strict();
export const allDeliveriesSchema = z.object(deliveriesShape).strict();
const exportDeliveriesShape = {
  format: format.optional(),
  limit: z.number().int().min(1).max(100_000).optional(),
  status: deliveryStatus.optional(),
  eventType: deliveryEvent.optional(),
} as const;
export const exportWebhookDeliveriesSchema = z
  .object({ webhookId: uuid, ...exportDeliveriesShape })
  .strict();
export const exportAllDeliveriesSchema = z.object(exportDeliveriesShape).strict();

export const banksSchema = z.object({ ifNoneMatch: z.string().optional() }).strict();
export const binSchema = z.object({ bin: z.string().regex(/^\d{6,8}$/) }).strict();
export const banxicoTimeseriesSchema = z
  .object({
    metric: z.enum(['probe_latency', 'verdict']).optional(),
    window: z.enum(['1h', '8h', '12h', '24h', '7d']).optional(),
  })
  .strict();

export const beneficiaryIdSchema = z.object({ beneficiaryId: entityId }).strict();
export const createBeneficiarySchema = z
  .object({
    accountNumber: z.string().regex(/^(?:\d{10}|\d{16}|\d{18})$/),
    bankCode: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
export const updateBeneficiarySchema = z
  .object({
    beneficiaryId: entityId,
    label: z.string().optional(),
    accountNumber: z.string().regex(/^(?:\d{10}|\d{16}|\d{18})$/).optional(),
    bankCode: z.string().optional(),
  })
  .strict()
  .refine(
    ({ beneficiaryId: _beneficiaryId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos un cambio.' },
  );
export const listBeneficiariesSchema = z
  .object({ withArchived: z.boolean().optional() })
  .strict();
export const beneficiaryLookupSchema = z.object({ account: z.string().min(1) }).strict();
export const exportBeneficiariesSchema = z
  .object({
    format: format.optional(),
    withArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
export const importTemplateSchema = z
  .object({ format: z.enum(['csv', 'xlsx', 'xls', 'txt', 'json']).optional() })
  .strict();
export const createImportSchema = z
  .object({
    fileBase64: beneficiaryImportBase64,
    filename: z.string().min(1).max(255).default('beneficiarios.csv'),
    parseMode: z.enum(['template', 'free']).default('template'),
  })
  .strict();
export const importIdSchema = z.object({ importId: entityId }).strict();
export const importPreviewSchema = z
  .object({
    importId: entityId,
    page: z.number().int().positive().optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    buckets: z
      .array(z.enum(['valid', 'correctable', 'fatal', 'duplicate_account', 'duplicate_alias']))
      .min(1)
      .optional(),
  })
  .strict();
export const editImportRowSchema = z
  .object({
    importId: entityId,
    rowId: entityId,
    parsedAccount: z.string().optional(),
    parsedLabel: z.string().optional(),
    parsedAccountType: z.enum(['clabe', 'card', 'phone']).optional(),
    parsedBankCode: z.string().optional(),
    parsedBankName: z.string().optional(),
  })
  .strict()
  .refine(
    ({ importId: _importId, rowId: _rowId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos una corrección.' },
  );
export const importRowSchema = z
  .object({ importId: entityId, rowId: entityId })
  .strict();

export const usageHistorySchema = z
  .object({ months: z.number().int().min(1).max(24).optional() })
  .strict();
export const usageBreakdownSchema = z.object({ period: z.string().optional() }).strict();
export const usageHeatmapSchema = z
  .object({ days: z.number().int().min(1).max(90).optional() })
  .strict();
export const exportUsageSchema = z
  .object({
    format: format.optional(),
    from: date.optional(),
    to: date.optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
export const updateMyRetryPolicySchema = z
  .object({ policy: retryPolicySchema, idempotencyKey })
  .strict();
export const dashboardSchema = z
  .object({ limit: z.number().int().min(1).max(100).optional() })
  .strict();
export const trendsSchema = z
  .object({
    range: z.enum(['24h', '7d', '30d', '90d']).optional(),
    metric: z.enum(['volume', 'latency']).optional(),
  })
  .strict();
export const topBanksSchema = z
  .object({
    metric: z.enum(['volume', 'errors']).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export const topBeneficiariesSchema = z
  .object({ limit: z.number().int().positive().optional() })
  .strict();

const financeBase = { month, userId: uuid.optional() } as const;
export const financeSummarySchema = z.object(financeBase).strict();
export const financeStatementSchema = z
  .object({ ...financeBase, format: z.enum(['pdf', 'xlsx', 'csv', 'html']).default('pdf') })
  .strict();
export const financePreviewSchema = z
  .object({
    ...financeBase,
    format: z.enum(['csv', 'xlsx', 'pdf', 'preview']).default('preview'),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
export const financeAccountingSchema = z
  .object({
    ...financeBase,
    format: z.enum(['csv', 'xlsx', 'pdf', 'preview']).default('preview'),
    limit: z.number().int().min(1).max(100_000).optional(),
    decimal: z.enum(['comma', 'dot']).optional(),
  })
  .strict();
export const financeCepsSchema = z
  .object({ from: date, to: date, userId: uuid.optional() })
  .strict();
