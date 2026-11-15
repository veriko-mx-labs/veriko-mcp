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
 * Operaciones públicas que el catálogo no anuncia como herramientas.
 *
 * La purga definitiva de una validación no se puede deshacer, y un asistente no
 * debe poder borrar datos así. Las dos existen en el spec y en el SDK:
 * `check:surface` las cuenta, pero ningún perfil ni nivel de riesgo las expone.
 */
export const NOT_EXPOSED_OPERATIONS = [
  'prepareValidationPurge',
  'executeValidationPurge',
] as const;

type Cost = 'none' | 'included' | 'quota';
type InputSchema = z.ZodType<Record<string, unknown>>;

/** Lo que una llamada a una herramienta comparte con el servidor que la rodea. */
export interface ToolRuntime {
  /** La herramienta lo fija cuando envía un `Idempotency-Key`, para que el servidor lo informe. */
  idempotencyKey?: string;
  /** Se cancela cuando el cliente cancela la petición. Las esperas largas y cada llamada al SDK la respetan. */
  signal?: AbortSignal | undefined;
  /** Informa el avance al cliente. Sólo existe cuando la petición trae un `progressToken`. */
  progress?: ((update: { progress: number; total?: number; message?: string }) => Promise<void>) | undefined;
  /** Lo que la herramienta puede leer del disco local; no existe por HTTP ni sin raíces. */
  files?: FileAccess | undefined;
  /** Sustituye al reloj y al temporizador reales en las pruebas. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface ToolDefinition {
  operationId: string;
  /** `true` en las herramientas que componen varias llamadas y no son una operación de la API. */
  helper: boolean;
  name: string;
  title: string;
  description: string;
  family: Family;
  risk: Risk;
  cost: Cost;
  core: boolean;
  /** Repetir la llamada con los mismos argumentos deja el mismo estado. */
  idempotent: boolean;
  /**
   * Pista `destructiveHint`: la llamada crea, modifica o borra datos. El directorio de Claude la pide en `true` en toda
   * herramienta que «modify or delete data», así que vale en cada escritura, no sólo en las que borran.
   */
  destructive: boolean;
  /** La llamada llega más allá de la API de Veriko (Banxico, o una URL que envía quien llama). */
  openWorld: boolean;
  inputSchema: InputSchema;
  /** El esquema que se anuncia en su lugar cuando el servidor puede leer archivos locales (stdio, con raíces). */
  localInputSchema?: InputSchema;
  /**
   * La pregunta que se le hace a la persona antes de ejecutar la llamada, cuando
   * el cliente puede preguntar. No existe en las herramientas que no piden confirmación.
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
  /** La herramienta envía un `Idempotency-Key`: el de quien llama, o uno aleatorio nuevo. */
  idempotencyKey?: boolean;
  inputSchema: T;
  /** Sustituye a `inputSchema` cuando el servidor puede leer archivos locales. */
  localInputSchema?: InputSchema;
  /** La pregunta que se confirma antes de la llamada, a partir de los argumentos validados. */
  confirmation?(args: z.output<T>): string;
  invoke(client: Veriko, args: z.output<T>, runtime: ToolRuntime): Promise<unknown>;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * El costo vive en `_meta`, que el modelo no lee. La descripción sí la lee, así
 * que la advertencia va ahí. Un ciclo de un agente puede gastar una cuota
 * mensual en minutos.
 */
export const QUOTA_WARNING =
  'Cada validación consume cuota del plan de la cuenta y se descuenta cuando se acepta la petición. Consulta el saldo con `veriko_get_usage_limits` antes de validar en lote.';

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
    destructive: options.destructive ?? risk !== 'read',
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

/** La entrada `snake_case` de la herramienta pasa al `camelCase` que recibe el SDK. Los objetos anidados se quedan como están. */
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

/** Un alcance de tres estados, `0` y `1` como los nombra la API, pasa al booleano del SDK. */
function scope(args: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = args[field];
  return value === undefined ? {} : { [field.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())]: value === 1 };
}

function filters(args: Record<string, unknown>): Record<string, unknown> {
  return { ...toSdk(args, ['with_deleted']), ...scope(args, 'with_deleted') };
}

/** Un `304` responde a una lectura condicional: es un éxito que significa «sin cambios». */
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

/** Los `attributes` de un recurso de la API, o el valor tal cual si no los trae. */
function attributesOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const attributes = (value as { attributes?: unknown }).attributes;
  return typeof attributes === 'object' && attributes !== null
    ? (attributes as Record<string, unknown>)
    : (value as Record<string, unknown>);
}

function accountDigits(value: string): string {
  return digitsOf(value);
}

const GUIDE_VERDICT =
  'El veredicto está en `attributes.status`: `valid` (el CEP existe y coincide), `not_found`, `cep_unavailable`, `returned`, `invalid`, `failed` o `error`. Un `not_found` inmediato no prueba que la transferencia no exista: Banxico puede no haber publicado aún el CEP, así que activa `retry_policy` o vuelve a consultar más tarde. `valid` es una fotografía del momento de la consulta. Para detectar una devolución, llama a `veriko_recheck_validation` dentro de las 72 horas. Cuando `attributes.account_cross_checked` es `false`, `valid` confirma que la transferencia existe, pero no que se pagó a la cuenta esperada.';

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  define({
    operationId: 'validateDirect',
    title: 'Validar una transferencia SPEI',
    description: `Valida una transferencia a partir de sus datos contra el CEP de Banxico. Envía \`amount\`, \`tracking_key\` o \`numeric_reference\`, y \`beneficiary_account\` o \`candidate_accounts\`. ${GUIDE_VERDICT}`,
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
    title: 'Validar un comprobante por OCR',
    description: `Extrae y valida una transferencia a partir de un comprobante: una imagen o un PDF de 1 a 3 páginas, enviado como URL HTTPS (\`image_url\`, la opción preferida) o como base64. ${GUIDE_VERDICT}`,
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
    title: 'Esperar el veredicto de una validación',
    description:
      'Consulta una validación hasta que llega a un estado final (`valid`, `not_found`, `cep_unavailable`, `invalid`, `returned`, `failed`, `error`), respetando el intervalo de consulta de la API, hasta `timeout_seconds` (25 por omisión). Devuelve el último estado con `waiting`, `terminal` y `next_poll_after_seconds`; cuando `waiting` es `true`, vuelve a llamarla. Úsala después de una validación asíncrona o en `processing`. No consume cuota.',
    family: 'validations',
    core: true,
    inputSchema: waitForValidationSchema,
    invoke: (client, args, runtime) => waitForValidation(client, args, runtime),
  }),
  define({
    operationId: 'listValidations',
    title: 'Listar validaciones',
    description:
      'Lista validaciones, de la más reciente a la más antigua, con filtros y paginación (`per_page` hasta 50). Acota los filtros cuando la respuesta sea grande.',
    family: 'validations',
    core: true,
    inputSchema: listValidationsSchema,
    invoke: (client, args) => client.validations.list(filters(args)),
  }),
  define({
    operationId: 'getValidation',
    title: 'Consultar una validación',
    description:
      'Lee una validación por su id, con su ETag. Envía `if_none_match` con el último ETag para recibir `{ not_modified: true }` cuando nada cambió. Mientras el estado sea `queued` o `processing`, espera con `veriko_wait_for_validation` en lugar de consultar en bucle.',
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
    title: 'Descargar el CEP',
    description:
      'Descarga el comprobante oficial de Banxico (CEP) en XML o PDF. El XML llega como texto en el resultado cuando es pequeño. Existe cuando la validación ya tiene un CEP (`valid` o `returned`).',
    family: 'validations',
    core: true,
    inputSchema: downloadCepSchema,
    invoke: (client, { validation_id, format }) => client.validations.cep(validation_id, { format }),
  }),
  define({
    operationId: 'getValidationImage',
    title: 'Descargar el comprobante de una validación',
    description:
      'Descarga el comprobante original (imagen o PDF) de una validación OCR. Responde 410 `image_not_retained` cuando la validación se creó con `retain_image: false`.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.image(validation_id),
  }),
  define({
    operationId: 'validationStats',
    title: 'Consultar estadísticas de validaciones',
    description: 'Cuenta las validaciones por estado, con los mismos filtros del listado (`status` no cambia los contadores).',
    family: 'validations',
    inputSchema: validationFiltersSchema,
    invoke: (client, args) => client.validations.stats(filters(args)),
  }),
  define({
    operationId: 'exportValidations',
    title: 'Exportar validaciones',
    description: 'Exporta el historial filtrado como archivo CSV o XLSX (hasta 100000 filas).',
    family: 'validations',
    inputSchema: exportValidationsSchema,
    invoke: (client, args) => client.validations.export(filters(args)),
  }),
  define({
    operationId: 'recheckValidation',
    title: 'Revisar el pago de una validación',
    description:
      'Vuelve a consultar a Banxico el estado de pago de una validación `valid` creada hace 72 horas como máximo, y la pasa a `returned` si el pago se devolvió. No consume cuota. Tiene un límite de una revisión cada 10 minutos (429 `recheck_rate_limited`).',
    family: 'validations',
    risk: 'write',
    openWorld: true,
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.recheck(validation_id),
  }),
  define({
    operationId: 'listValidationRetryAttempts',
    title: 'Listar intentos de una validación',
    description: 'Lista los intentos del ciclo de reintentos automáticos de una validación.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validation_id }) => client.validations.retryAttempts(validation_id),
  }),
  define({
    operationId: 'updateValidationRetryPolicy',
    title: 'Cambiar reintentos de una validación',
    description:
      'Reemplaza la política de reintentos automáticos de una validación. Los reintentos no consumen cuota. El plan limita `max_retries`.',
    family: 'validations',
    risk: 'write',
    idempotent: true,
    destructive: true,
    idempotencyKey: true,
    inputSchema: validationRetryPolicySchema,
    confirmation: (args) =>
      `¿Reemplazar la política de reintentos de la validación ${args.validation_id} por ${JSON.stringify(args.retry_policy)}? Se sobrescribe la política anterior.`,
    invoke: (client, args, runtime) =>
      client.validations.setRetryPolicy(args.validation_id, args.retry_policy, {
        idempotencyKey: runtime.idempotencyKey,
      }),
  }),
  define({
    operationId: 'cancelValidationRetries',
    title: 'Cancelar reintentos de una validación',
    description: 'Cancela los reintentos automáticos pendientes de una validación. La validación conserva su estado actual.',
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
    title: 'Retirar una validación',
    description:
      'Retira una validación del historial visible (borrado lógico). No purga los datos; las retiradas se listan con `with_deleted: 1`.',
    family: 'validations',
    risk: 'destructive',
    idempotent: true,
    inputSchema: validationIdSchema,
    confirmation: (args) =>
      `¿Retirar la validación ${args.validation_id} del historial visible? Los datos se conservan; sólo sale del listado por omisión.`,
    invoke: (client, { validation_id }) => client.validations.delete(validation_id),
  }),
  define({
    operationId: 'sendCepToTelegram',
    title: 'Enviar el CEP a Telegram',
    description: 'Envía el CEP por la integración de Telegram configurada en la cuenta. Responde 409 si no hay ninguna vinculada.',
    family: 'validations',
    risk: 'write',
    openWorld: true,
    idempotencyKey: true,
    inputSchema: validationIdempotentSchema,
    invoke: (client, args, runtime) =>
      client.validations.sendCepToTelegram(args.validation_id, { idempotencyKey: runtime.idempotencyKey }),
  }),

  define({
    operationId: 'createWebhook',
    title: 'Crear un webhook',
    description:
      'Registra una URL HTTPS de destino y sus eventos. El secreto de firma (`attributes.secret`) aparece sólo en esta respuesta y entra a la conversación: no lo repitas y guárdalo donde lo lee la integración.',
    family: 'webhooks',
    risk: 'write',
    openWorld: true,
    inputSchema: createWebhookSchema,
    invoke: (client, args) =>
      client.webhooks.create(args as Parameters<Veriko['webhooks']['create']>[0]),
  }),
  define({
    operationId: 'listWebhooks',
    title: 'Listar webhooks',
    description: 'Lista los webhooks de la cuenta.',
    family: 'webhooks',
    inputSchema: emptySchema,
    invoke: (client) => client.webhooks.list(),
  }),
  define({
    operationId: 'updateWebhook',
    title: 'Actualizar un webhook',
    description: 'Cambia la URL, los eventos, la etiqueta o el estado de un webhook. Una lista en `events` reemplaza a la actual.',
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
    title: 'Eliminar un webhook',
    description: 'Elimina un webhook y detiene sus entregas.',
    family: 'webhooks',
    risk: 'destructive',
    idempotent: true,
    inputSchema: webhookIdSchema,
    confirmation: (args) =>
      `¿Eliminar el webhook ${args.webhook_id}? Sus entregas se detienen de inmediato.`,
    invoke: (client, { webhook_id }) => client.webhooks.delete(webhook_id),
  }),
  define({
    operationId: 'sendWebhookTest',
    title: 'Probar un webhook',
    description: 'Envía un evento sintético `test` a la URL del webhook y informa la respuesta del receptor.',
    family: 'webhooks',
    risk: 'write',
    openWorld: true,
    inputSchema: webhookIdSchema,
    invoke: (client, { webhook_id }) => client.webhooks.test(webhook_id),
  }),
  define({
    operationId: 'regenerateWebhookSecret',
    title: 'Rotar el secreto de un webhook',
    description:
      'Genera un secreto de firma nuevo y lo devuelve una sola vez (`attributes.secret`; entra a la conversación, así que guárdalo y no lo repitas). El secreto anterior sigue firmando 24 horas (`previous_secret_expires_at`), salvo que `immediate` sea `true`, que lo revoca de inmediato: úsalo cuando el secreto anterior quedó expuesto.',
    family: 'webhooks',
    risk: 'destructive',
    inputSchema: regenerateWebhookSecretSchema,
    confirmation: (args) =>
      args.immediate === true
        ? `¿Rotar el secreto de firma del webhook ${args.webhook_id} y revocar el anterior de inmediato? Los receptores que aún verifican con él fallan al instante.`
        : `¿Rotar el secreto de firma del webhook ${args.webhook_id}? El secreto anterior sigue firmando 24 horas. El secreto nuevo aparece una sola vez en el resultado.`,
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
    title: 'Listar entregas de un webhook',
    description: 'Lista los intentos de entrega de un webhook, con la respuesta del receptor.',
    family: 'webhooks',
    inputSchema: webhookDeliveriesSchema,
    invoke(client, { webhook_id, ...params }) {
      return client.webhooks.deliveries(webhook_id, toSdk(params));
    },
  }),
  define({
    operationId: 'listAllDeliveries',
    title: 'Listar todas las entregas',
    description: 'Lista las entregas de todos los webhooks, o de la lista `endpoint_id`, con filtros.',
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
    title: 'Exportar las entregas de un webhook',
    description: 'Exporta las entregas de un webhook como archivo CSV o XLSX.',
    family: 'webhooks',
    inputSchema: exportWebhookDeliveriesSchema,
    invoke(client, { webhook_id, ...params }) {
      return client.webhooks.exportDeliveries(webhook_id, toSdk(params));
    },
  }),
  define({
    operationId: 'exportAllDeliveries',
    title: 'Exportar todas las entregas',
    description: 'Exporta las entregas consolidadas como archivo CSV o XLSX.',
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
    title: 'Listar bancos SPEI',
    description:
      'Devuelve el catálogo de participantes SPEI con sus códigos. Es público: no necesita clave de API. Envía `if_none_match` para no descargarlo dos veces.',
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
    title: 'Resolver el BIN de una tarjeta',
    description:
      'Identifica el banco emisor a partir de los primeros 6 a 8 dígitos de una tarjeta. Envía sólo esos dígitos, nunca el número completo. Es público: no necesita clave de API.',
    family: 'catalog',
    inputSchema: binSchema,
    invoke: (client, { bin }) => client.catalog.binLookup(bin),
  }),
  define({
    operationId: 'getSpeiCalendar',
    title: 'Consultar el calendario SPEI',
    description:
      'Devuelve los días inhábiles SPEI de un año y la disposición oficial de la que salen. Un año fuera de los cubiertos responde 404 con `meta.covered_years`. Es público: no necesita clave de API.',
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
    title: 'Consultar el estado de Banxico',
    description: 'Devuelve el estado público del servicio CEP de Banxico. Consúltalo cuando las validaciones respondan `cep_unavailable`.',
    family: 'catalog',
    cost: 'none',
    openWorld: true,
    inputSchema: emptySchema,
    invoke: (client) => client.catalog.banxicoStatus(),
  }),
  define({
    operationId: 'banxicoPublicTimeseries',
    title: 'Consultar una serie de Banxico',
    description: 'Devuelve una serie pública de latencia o de veredictos de las sondas de Banxico en una ventana.',
    family: 'catalog',
    cost: 'none',
    openWorld: true,
    inputSchema: banxicoTimeseriesSchema,
    invoke: (client, args) => client.catalog.banxicoTimeseries(args),
  }),

  define({
    operationId: 'createBeneficiary',
    title: 'Crear un beneficiario',
    description:
      'Guarda una cuenta beneficiaria (CLABE, tarjeta o teléfono DiMo). Un teléfono necesita `bank_code`. Si la cuenta estaba archivada, se reactiva y `reactivated` es `true`.',
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
    title: 'Listar beneficiarios',
    description: 'Lista las cuentas beneficiarias guardadas. `with_archived: 1` devuelve sólo las archivadas.',
    family: 'beneficiaries',
    inputSchema: listBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.list(scope(args, 'with_archived')),
  }),
  define({
    operationId: 'updateBeneficiary',
    title: 'Actualizar un beneficiario',
    description: 'Cambia la etiqueta, la cuenta o el banco de un beneficiario. Una cuenta nueva reemplaza a la actual.',
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
    title: 'Archivar un beneficiario',
    description: 'Archiva una cuenta beneficiaria. Si vuelves a crear la misma cuenta, se reactiva.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: beneficiaryIdSchema,
    confirmation: (args) =>
      `¿Archivar el beneficiario ${args.beneficiary_id}?`,
    invoke: (client, { beneficiary_id }) => client.beneficiaries.delete(beneficiary_id),
  }),
  define({
    operationId: 'lookupBeneficiaryAccount',
    title: 'Buscar una cuenta beneficiaria',
    description: 'Resuelve un número de cuenta completo (10, 16 o 18 dígitos) entre los beneficiarios guardados.',
    family: 'beneficiaries',
    inputSchema: beneficiaryLookupSchema,
    invoke: (client, { account }) => client.beneficiaries.lookup(accountDigits(account)),
  }),
  define({
    operationId: 'validateAccount',
    title: 'Validar un número de cuenta',
    description:
      'Comprueba el dígito verificador de una CLABE, el dígito Luhn de una tarjeta o el formato de un teléfono, y resuelve el banco. No consume cuota y responde 200 incluso con un número mal formado (`checksum_valid: false`, `account_type: unknown`). Úsala para corregir una cuenta antes de gastar una validación.',
    family: 'beneficiaries',
    core: true,
    inputSchema: validateAccountSchema,
    invoke: (client, args) => client.beneficiaries.validateAccount(args),
  }),
  define({
    operationId: 'exportBeneficiaries',
    title: 'Exportar beneficiarios',
    description: 'Exporta los beneficiarios como archivo CSV o XLSX.',
    family: 'beneficiaries',
    inputSchema: exportBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.export(toSdkScope(args)),
  }),
  define({
    operationId: 'downloadBeneficiaryImportTemplate',
    title: 'Descargar la plantilla de importación de beneficiarios',
    description: 'Descarga la plantilla de importación con las columnas esperadas, en `csv`, `xlsx`, `xls`, `txt` o `json`.',
    family: 'beneficiaries',
    inputSchema: importTemplateSchema,
    invoke: (client, args) => client.beneficiaries.importTemplate(args),
  }),
  define({
    operationId: 'createBeneficiaryImport',
    title: 'Iniciar una importación de beneficiarios',
    description:
      'Sube un archivo (base64, o una ruta en esta computadora cuando el servidor lo permite; hasta 20 MB) para preparar una importación. Sólo puede haber un trabajo abierto a la vez (422 `import_already_in_flight`). Después llama a `veriko_wait_for_beneficiary_import`, revisa la vista previa y confirma.',
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
    title: 'Consultar una importación de beneficiarios',
    description: 'Devuelve el estado y los contadores de un trabajo de importación.',
    family: 'beneficiaries',
    inputSchema: importIdSchema,
    invoke: (client, { import_id }) => client.beneficiaries.importStatus(import_id),
  }),
  define({
    operationId: 'waitForBeneficiaryImport',
    helper: true,
    title: 'Esperar una importación de beneficiarios',
    description:
      'Consulta un trabajo de importación hasta que está en `preview_ready` o en un estado final (`completed`, `failed`, `cancelled`), hasta `timeout_seconds` (25 por omisión). Devuelve el último estado con `waiting` y `terminal`; cuando `waiting` es `true`, vuelve a llamarla.',
    family: 'beneficiaries',
    inputSchema: waitForImportSchema,
    invoke: (client, args, runtime) => waitForImport(client, args, runtime),
  }),
  define({
    operationId: 'cancelBeneficiaryImport',
    title: 'Cancelar una importación de beneficiarios',
    description: 'Cancela una importación que aún no se confirmó.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: importIdSchema,
    invoke: (client, { import_id }) => client.beneficiaries.importCancel(import_id),
  }),
  define({
    operationId: 'getBeneficiaryImportPreview',
    title: 'Revisar la vista previa de una importación',
    description: 'Lista las filas clasificadas de la vista previa de la importación (`valid`, `correctable`, `fatal`, duplicadas).',
    family: 'beneficiaries',
    inputSchema: importPreviewSchema,
    invoke(client, { import_id, ...params }) {
      return client.beneficiaries.importPreview(import_id, toSdk(params));
    },
  }),
  define({
    operationId: 'patchBeneficiaryImportRow',
    title: 'Corregir una fila de la importación',
    description: 'Corrige una fila de la vista previa y la reprocesa.',
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
    title: 'Quitar una fila de la importación',
    description: 'Quita una fila de la vista previa.',
    family: 'beneficiaries',
    risk: 'destructive',
    idempotent: true,
    inputSchema: importRowSchema,
    confirmation: (args) =>
      `¿Quitar la fila ${args.row_id} de la vista previa de la importación ${args.import_id}?`,
    invoke: (client, { import_id, row_id }) => client.beneficiaries.importRemoveRow(import_id, row_id),
  }),
  define({
    operationId: 'commitBeneficiaryImport',
    title: 'Confirmar una importación de beneficiarios',
    description:
      'Crea o actualiza beneficiarios a partir de las filas válidas de la vista previa. No se puede deshacer por lote: revisa antes la vista previa.',
    family: 'beneficiaries',
    // Se trata como destructiva porque escribe muchos registros de una vez.
    risk: 'destructive',
    inputSchema: importIdSchema,
    confirmation: (args) =>
      `¿Confirmar la importación ${args.import_id}? Crea o actualiza beneficiarios con cada fila válida de la vista previa y no se puede deshacer por lote.`,
    invoke: (client, { import_id }) => client.beneficiaries.importCommit(import_id),
  }),

  define({
    operationId: 'getUsageSummary',
    title: 'Consultar el consumo',
    description: 'Devuelve el resumen de consumo de cuota del periodo actual, con el porcentaje consumido.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.summary(),
  }),
  define({
    operationId: 'getUsageHistory',
    title: 'Consultar el historial de consumo',
    description: 'Devuelve el consumo mensual de los últimos meses, frente al tope del plan actual.',
    family: 'usage',
    inputSchema: usageHistorySchema,
    invoke: (client, args) => client.usage.history(args),
  }),
  define({
    operationId: 'getUsageBreakdown',
    title: 'Desglosar el consumo',
    description: 'Desglosa el consumo de un periodo por tipo de operación.',
    family: 'usage',
    inputSchema: usageBreakdownSchema,
    invoke: (client, args) => client.usage.breakdown(args),
  }),
  define({
    operationId: 'getUsageLimits',
    title: 'Consultar la cuota y los límites',
    description:
      'Devuelve en `quota` la cuota de validaciones del plan (límite, consumidas, restantes y reinicio) y en `rate_limits` los límites de peticiones por minuto. Consúltalo antes de validar en lote.',
    family: 'usage',
    core: true,
    inputSchema: emptySchema,
    async invoke(client) {
      const [summary, limits] = await Promise.all([client.usage.summary(), client.usage.limits()]);
      return { quota: attributesOf(summary), rate_limits: attributesOf(limits).rate_limits ?? null };
    },
  }),
  define({
    operationId: 'getUsageHeatmap',
    title: 'Consultar el mapa de calor del consumo',
    description: 'Devuelve el consumo diario del rango solicitado.',
    family: 'usage',
    inputSchema: usageHeatmapSchema,
    invoke: (client, args) => client.usage.heatmap(args),
  }),
  define({
    operationId: 'getApiUsage',
    title: 'Consultar el uso de la API',
    description: 'Devuelve la actividad reciente de la API en la cuenta.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.apiUsage(),
  }),
  define({
    operationId: 'exportApiUsage',
    title: 'Exportar el uso de la API',
    description: 'Exporta la actividad de la API como archivo CSV o XLSX.',
    family: 'usage',
    inputSchema: exportUsageSchema,
    invoke: (client, args) => client.usage.export(args),
  }),

  define({
    operationId: 'myProfile',
    title: 'Consultar mi perfil',
    description: 'Devuelve los datos del integrador autenticado: perfil, plan, permisos y resumen de notificaciones.',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.myProfile(),
  }),
  define({
    operationId: 'getMyRetryPolicy',
    title: 'Consultar la política de reintentos',
    description: 'Devuelve la política predeterminada de reintentos automáticos de la cuenta y los topes del plan (`meta.caps`).',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.getMyRetryPolicy(),
  }),
  define({
    operationId: 'updateMyRetryPolicy',
    title: 'Cambiar la política de reintentos',
    description: 'Reemplaza la política de reintentos predeterminada de la cuenta. Las validaciones nuevas la usan, salvo que envíen su propio `retry_policy`.',
    family: 'account',
    risk: 'write',
    idempotent: true,
    destructive: true,
    idempotencyKey: true,
    inputSchema: updateMyRetryPolicySchema,
    confirmation: (args) =>
      `¿Reemplazar la política de reintentos predeterminada de la cuenta por ${JSON.stringify(args.retry_policy)}? Las validaciones nuevas la usan, salvo que envíen la suya.`,
    invoke: (client, args, runtime) =>
      client.account.updateMyRetryPolicy(args.retry_policy, {
        idempotencyKey: runtime.idempotencyKey,
      }),
  }),
  define({
    operationId: 'getDashboardSummary',
    title: 'Consultar el resumen operativo',
    description: 'Devuelve los indicadores principales del panel y las validaciones más recientes.',
    family: 'dashboard',
    inputSchema: dashboardSchema,
    invoke: (client, args) => client.dashboard.getSummary(args),
  }),
  define({
    operationId: 'listPublicPlans',
    title: 'Listar los planes públicos',
    description: 'Lista los planes públicos. No necesita clave de API.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.listPublic(),
  }),
  define({
    operationId: 'getPublicPlanComparison',
    title: 'Comparar los planes públicos',
    description: 'Compara las capacidades y los precios de los planes públicos. No necesita clave de API.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.getPublicPlanComparison(),
  }),
  define({
    operationId: 'getUserInsightsOverview',
    title: 'Consultar el resumen de métricas',
    description: 'Devuelve métricas agregadas de la cuenta.',
    family: 'insights',
    inputSchema: emptySchema,
    invoke: (client) => client.insights.getOverview(),
  }),
  define({
    operationId: 'getUserInsightsTrends',
    title: 'Consultar tendencias',
    description: 'Devuelve tendencias de volumen o de latencia en una ventana.',
    family: 'insights',
    inputSchema: trendsSchema,
    invoke: (client, args) => client.insights.getTrends(args),
  }),
  define({
    operationId: 'getUserInsightsTopBanks',
    title: 'Consultar los bancos principales',
    description: 'Ordena los bancos por volumen o por tasa de error.',
    family: 'insights',
    inputSchema: topBanksSchema,
    invoke: (client, args) => client.insights.getTopBanks(args),
  }),
  define({
    operationId: 'getUserInsightsTopBeneficiaries',
    title: 'Consultar los beneficiarios principales',
    description: 'Devuelve los beneficiarios con más actividad.',
    family: 'insights',
    inputSchema: topBeneficiariesSchema,
    invoke: (client, args) => client.insights.getTopBeneficiaries(args),
  }),

  define({
    operationId: 'getFinanceSummary',
    title: 'Consultar el resumen financiero',
    description: 'Devuelve el resumen financiero de un mes.',
    family: 'finance',
    inputSchema: financeSummarySchema,
    invoke: (client, args) => client.finance.getSummary(args),
  }),
  define({
    operationId: 'getFinanceStatement',
    title: 'Descargar el estado financiero mensual',
    description: 'Genera el estado financiero mensual como archivo PDF, XLSX, CSV o HTML.',
    family: 'finance',
    inputSchema: financeStatementSchema,
    invoke: (client, args) => client.finance.getStatement(args),
  }),
  define({
    operationId: 'getFinanceMonthly',
    title: 'Consultar los movimientos mensuales',
    description: 'Devuelve los movimientos del mes: una vista previa estructurada de 20 filas por omisión, o un archivo con `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getMonthly(args),
  }),
  define({
    operationId: 'getFinanceCounterparties',
    title: 'Consultar las contrapartes',
    description: 'Devuelve las contrapartes de un mes: una vista previa estructurada de 20 filas por omisión, o un archivo con `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getCounterparties(args),
  }),
  define({
    operationId: 'getFinanceByBank',
    title: 'Consultar las finanzas por banco',
    description: 'Devuelve el mes agrupado por banco: una vista previa estructurada de 20 filas por omisión, o un archivo con `format`.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getByBank(args),
  }),
  define({
    operationId: 'getFinanceAccounting',
    title: 'Consultar el reporte contable',
    description: 'Devuelve el reporte contable de un mes: una vista previa de 20 filas por omisión, o un archivo con `format`. `decimal` elige el separador.',
    family: 'finance',
    inputSchema: financeAccountingSchema,
    invoke: (client, args) => client.finance.getAccounting(args),
  }),
  define({
    operationId: 'getFinanceCeps',
    title: 'Descargar los CEP por rango',
    description: 'Arma un ZIP con los CEP de un rango de fechas y lo devuelve como archivo. Para rangos grandes usa `veriko_create_finance_cep_export`.',
    family: 'finance',
    inputSchema: financeCepsSchema,
    invoke: (client, args) => client.finance.getCeps(args),
  }),
  define({
    operationId: 'createFinanceCepExport',
    title: 'Pedir una exportación de CEP',
    description:
      'Pide que el ZIP de CEP de un rango se arme en segundo plano (hasta 10000). Si ya hay una exportación en curso del mismo rango, devuelve esa. Después llama a `veriko_wait_for_cep_export` y a `veriko_download_finance_cep_export`.',
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
    title: 'Listar las exportaciones de CEP',
    description: 'Lista las exportaciones de CEP recientes, de la más reciente a la más antigua.',
    family: 'finance',
    inputSchema: emptySchema,
    invoke: (client) => client.finance.listCepExports(),
  }),
  define({
    operationId: 'getFinanceCepExport',
    title: 'Consultar una exportación de CEP',
    description: 'Devuelve el estado de una exportación de CEP: `queued`, `building`, `ready`, `failed` o `expired`. Con `ready`, el ZIP se puede descargar.',
    family: 'finance',
    inputSchema: financeCepExportIdSchema,
    invoke: (client, { export_id }) => client.finance.getCepExport(export_id),
  }),
  define({
    operationId: 'waitForCepExport',
    helper: true,
    title: 'Esperar una exportación de CEP',
    description:
      'Consulta una exportación de CEP hasta que está en `ready`, `failed` o `expired`, hasta `timeout_seconds` (25 por omisión). Devuelve el último estado con `waiting` y `terminal`; cuando `waiting` es `true`, vuelve a llamarla.',
    family: 'finance',
    inputSchema: waitForCepExportSchema,
    invoke: (client, args, runtime) => waitForCepExport(client, args, runtime),
  }),
  define({
    operationId: 'downloadFinanceCepExport',
    title: 'Descargar una exportación de CEP',
    description: 'Descarga el ZIP de una exportación de CEP en `ready`. El ZIP llega como enlace a un recurso cuando es grande.',
    family: 'finance',
    inputSchema: financeCepExportIdSchema,
    invoke: (client, { export_id }) => client.finance.downloadCepExport(export_id),
  }),
  define({
    operationId: 'billingGetSubscription',
    title: 'Consultar la suscripción',
    description: 'Devuelve el estado de la suscripción activa.',
    family: 'billing',
    inputSchema: emptySchema,
    invoke: (client) => client.billing.getSubscription(),
  }),
] as const;

function toSdkScope(args: Record<string, unknown>): Record<string, unknown> {
  return { ...toSdk(args, ['with_archived']), ...scope(args, 'with_archived') };
}

/** Las herramientas que corresponden a una operación de la API pública. */
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
