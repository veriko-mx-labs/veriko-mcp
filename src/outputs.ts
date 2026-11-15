import { z } from 'zod';

/**
 * La forma de `structuredContent` para cada tipo de herramienta.
 *
 * Todos los esquemas son abiertos (`looseObject`): el servidor devuelve el
 * recurso de la API tal como lo interpretó el SDK, y la API puede agregar campos
 * sin una versión nueva del MCP. Los esquemas fijan en qué puede confiar un
 * cliente, no cada campo de un recurso.
 */
/**
 * Declarado de forma compacta: el esquema se repite en cada herramienta de `tools/list` y el
 * objeto es abierto. Además de estos campos trae `request_id`, `quota`, `rate_limit`,
 * `deprecation` y `sunset` cuando la respuesta los tiene.
 */
export const callInfo = z
  .looseObject({
    idempotency_key: z.string().optional().describe('Repítela para reintentar esta llamada sin riesgo.'),
    idempotent_replayed: z.boolean().optional().describe('`true`: se devolvió la respuesta guardada de una llamada anterior.'),
    quota_warning: z.string().optional(),
    retry_after_seconds: z.number().optional(),
  })
  .describe('Datos de la llamada, tomados de los metadatos de la respuesta.');

const base = { _call: callInfo.optional() };

const resource = z.looseObject({
  ...base,
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  etag: z.string().optional(),
  not_modified: z.boolean().optional().describe('`true` cuando `if_none_match` coincidió: el recurso no cambió.'),
});

const page = z.looseObject({
  ...base,
  items: z.array(z.unknown()).optional(),
  page: z.number().optional(),
  per_page: z.number().optional(),
  total: z.number().optional(),
  total_pages: z.number().optional(),
  has_next: z.boolean().optional(),
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
    .describe('El archivo descargado. Su contenido viene en el resultado cuando es pequeño, o se lee en `uri` con resources/read.'),
  embedded: z.boolean().describe('`true` cuando el contenido viene incluido en este resultado.'),
});

const wait = z.looseObject({
  ...base,
  resource: z.unknown().describe('El último estado leído.'),
  terminal: z.boolean().describe('`true` cuando el estado ya no cambia.'),
  waiting: z.boolean().describe('`true` cuando se acabó primero el tiempo límite: vuelve a llamar a la herramienta.'),
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
