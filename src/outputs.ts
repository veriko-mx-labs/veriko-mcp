import { z } from 'zod';

/**
 * The shape of `structuredContent` for each kind of tool.
 *
 * Every schema is open (`looseObject`): the server returns the API resource as
 * the SDK parsed it, and the API can add fields without a new MCP release. The
 * schemas pin down what a client can rely on, not every field of a resource.
 */
/**
 * Declared compactly: the schema is repeated in every tool of `tools/list`, and the
 * object is open. Besides these fields it carries `request_id`, `quota`, `rate_limit`,
 * `deprecation` and `sunset` when the response has them.
 */
export const callInfo = z
  .looseObject({
    idempotency_key: z.string().optional().describe('Repeat it to retry this call safely.'),
    idempotent_replayed: z.boolean().optional().describe('`true`: the stored response of an earlier call was returned.'),
    quota_warning: z.string().optional(),
    retry_after_seconds: z.number().optional(),
  })
  .describe('Facts about the call, from the response metadata.');

const base = { _call: callInfo.optional() };

const resource = z.looseObject({
  ...base,
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  etag: z.string().optional(),
  not_modified: z.boolean().optional().describe('`true` when `if_none_match` matched: the resource did not change.'),
});

const page = z.looseObject({
  ...base,
  items: z.array(z.unknown()).optional(),
  page: z.number().optional(),
  perPage: z.number().optional(),
  total: z.number().optional(),
  totalPages: z.number().optional(),
  hasNext: z.boolean().optional(),
});

const file = z.looseObject({
  ...base,
  artifact: z
    .object({
      uri: z.string(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number(),
      sha256: z.string(),
    })
    .describe('The downloaded file. Its content is in the result when small, or readable at `uri` through resources/read.'),
  embedded: z.boolean().describe('`true` when the content is included in this result.'),
});

const wait = z.looseObject({
  ...base,
  resource: z.unknown().describe('The last state read.'),
  terminal: z.boolean().describe('`true` when the state no longer changes.'),
  waiting: z.boolean().describe('`true` when the time limit ended first: call the tool again.'),
  status: z.string().optional(),
  next_poll_after_seconds: z.number().optional(),
  polls: z.number(),
  waited_seconds: z.number(),
});

const anything = z.looseObject(base);

const FILE_OPERATIONS = new Set([
  'downloadCep',
  'getValidationImage',
  'exportValidations',
  'exportWebhookDeliveries',
  'exportAllDeliveries',
  'exportBeneficiaries',
  'downloadBeneficiaryImportTemplate',
  'exportApiUsage',
  'getFinanceStatement',
  'getFinanceCeps',
  'downloadFinanceCepExport',
]);
const PAGE_OPERATIONS = new Set(['listValidations', 'listWebhookDeliveries', 'listAllDeliveries']);
const RESOURCE_OPERATIONS = new Set([
  'validateDirect',
  'validateOcr',
  'getValidation',
  'getBeneficiaryImport',
  'getFinanceCepExport',
  'createWebhook',
  'updateWebhook',
]);

export function isFileOperation(operationId: string): boolean {
  return FILE_OPERATIONS.has(operationId);
}

export function outputSchemaFor(operationId: string, helper: boolean): z.ZodType {
  if (helper) return wait;
  if (FILE_OPERATIONS.has(operationId)) return file;
  if (PAGE_OPERATIONS.has(operationId)) return page;
  if (RESOURCE_OPERATIONS.has(operationId)) return resource;
  return anything;
}
