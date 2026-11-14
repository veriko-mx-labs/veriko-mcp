import { TERMINAL_STATUSES, WEBHOOK_EVENTS } from '@veriko-mx/sdk-runtime';
import { z } from 'zod';

/*
 * Las entradas de las herramientas usan los nombres de campo en inglés de la
 * API pública, en snake_case, tal como la API los nombra en la red. Los
 * adaptadores de `catalog.ts` los pasan a los parámetros del SDK.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD.');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Usa el formato AAAA-MM.');
const uuid = z.string().uuid();
const speiBankCode = z.string().regex(/^\d{4,5}$/, 'Usa un código SPEI de 4 o 5 dígitos.');
const entityId = z.union([z.string().min(1), z.number().int().positive()]);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'The URL must use HTTPS.');
/** Los formatos de las exportaciones de validaciones y de entregas de webhook. */
export const EXPORT_FORMAT_VALUES = ['csv', 'xlsx'] as const;
const format = z.enum(EXPORT_FORMAT_VALUES);
/** CLABE (18 dígitos), tarjeta (16) o teléfono DiMo (10). Mismo patrón que la API. */
const account = z.string().regex(/^(?:\d{10}|\d{16}|\d{18})$/, 'Usa 10, 16 o 18 dígitos, sin separadores.');
const candidateAccounts = z
  .array(account)
  .min(2)
  .max(10)
  .refine((accounts) => new Set(accounts).size === accounts.length, {
    message: 'Las cuentas candidatas no deben repetirse.',
  });
const clientRefFilter = z.string().min(1).max(64);
const clientRef = clientRefFilter.regex(
  /^[^\x00-\x1f\x7f]+$/,
  'No uses saltos de línea ni caracteres de control.',
);

const sensitiveAccountNote =
  'Sólo dígitos: el servidor quita espacios y guiones, pero envíalos limpios.';

export const idempotencyKeyField = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,255}$/, 'Usa sólo A-Z, a-z, 0-9, _ o -.')
  .optional()
  .describe(
    'Opcional. Sin ella, cada llamada es un intento nuevo con una clave aleatoria distinta. Para reintentar sin riesgo tras una respuesta perdida, envía la misma clave de la primera vez: dentro de 24 horas la API repite la respuesta guardada (`idempotent_replayed: true`) y no ejecuta la operación otra vez. Reutilizar una clave con un cuerpo distinto devuelve 422 `idempotency_key_reused`.',
  );

function base64Bytes(maxBytes: number, label: string) {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  return z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (value.length % 4 !== 0) {
        context.addIssue({ code: 'custom', message: 'Base64 no válido.' });
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
        context.addIssue({ code: 'custom', message: 'Base64 no válido.' });
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

const ocrImageBase64 = base64Bytes(12 * 1024 * 1024, 'The image');
const beneficiaryImportBase64 = base64Bytes(20 * 1024 * 1024, 'The file');

export const emptySchema = z.object({}).strict();

export const retryPolicySchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe('`true` activa los reintentos automáticos. Con `false` se ignoran los demás campos.'),
    max_retries: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Máximo de reintentos, al menos 1. El plan lo limita (free 1, personal 3, business 5, enterprise 10, volume 20); por encima del tope la API responde 422 `retry_policy_invalid`. `veriko_get_my_retry_policy` devuelve el tope en `meta.caps`.',
      ),
    interval_seconds: z
      .number()
      .int()
      .min(300)
      .max(86_400)
      .optional()
      .describe('Segundos entre reintentos, de 300 (5 minutos) a 86400 (24 horas).'),
    outcomes: z
      .array(z.enum(['not_found', 'cep_unavailable', 'error']))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Los resultados no deben repetirse.',
      })
      .optional()
      .describe('Resultados que provocan un reintento. Los reintentos no consumen cuota.'),
  })
  .strict()
  .describe(
    'Política de reintentos automáticos. Omítela para usar la de la cuenta (`veriko_get_my_retry_policy`).',
  );

const asyncField = z
  .boolean()
  .default(false)
  .describe(
    '`true` encola la validación y responde de inmediato con `status: queued` y el `id`; después llama a `veriko_wait_for_validation`. Con `false` la llamada espera hasta 45 segundos a Banxico y, pasado ese tiempo, responde `processing` con `meta.async_reason: sync_deadline`. En ambos casos la validación consume cuota.',
  );

const accountPairRules = {
  both: 'Send `beneficiary_account` or `candidate_accounts`, not both.',
} as const;

export const validateDirectSchema = z
  .object({
    send_date: date
      .optional()
      .describe(
        'Fecha en que se envió la transferencia, `AAAA-MM-DD`. Banxico la usa para localizar el CEP; puede ser distinta del día de operación que imprime el CEP. Opcional: sin ella la API prueba fechas candidatas y responde 422 sólo cuando no tiene de dónde inferirla.',
      ),
    amount: z
      .union([
        z.number().positive().max(9_999_999_999_999.99),
        z.string().regex(/^\d{1,13}(?:\.\d{1,2})?$/),
      ])
      .describe(
        'Monto en pesos mexicanos (MXN), mayor que cero, con hasta dos decimales y 13 dígitos enteros. Se acepta una cadena como `"1500.50"`; no uses notación científica.',
      ),
    tracking_key: z
      .string()
      .min(1)
      .max(30)
      .optional()
      .describe(
        'Clave de rastreo SPEI (1 a 30 caracteres). Envía `tracking_key` o `numeric_reference`. Si envías las dos, la consulta va sólo por clave de rastreo.',
      ),
    numeric_reference: z
      .string()
      .regex(/^\d{1,7}$/)
      .optional()
      .describe('Referencia numérica, de 1 a 7 dígitos. Obligatoria cuando falta `tracking_key`.'),
    beneficiary_account: account
      .optional()
      .describe(
        `Cuenta receptora: CLABE (18 dígitos), tarjeta (16) o teléfono DiMo (10). ${accountPairRules.both} ${sensitiveAccountNote}`,
      ),
    candidate_accounts: candidateAccounts
      .optional()
      .describe(
        'Dos o más cuentas, una de las cuales recibió la transferencia, cuando no se sabe cuál. El servicio permite 3 por omisión (una lista mayor responde 422 con `meta.max`) y nunca más de 10. Una unidad de cuota sin importar cuántas sean; `attributes.candidate_match` indica cuál coincidió. Reemplaza a `beneficiary_account`.',
      ),
    sender_bank: z
      .string()
      .max(255)
      .optional()
      .describe(
        'Banco emisor, nombre o código SPEI. Si falta o es incorrecto, la clave de rastreo puede aportarlo.',
      ),
    receiver_bank: z
      .string()
      .max(255)
      .optional()
      .describe(
        'Banco receptor, nombre o código SPEI. Opcional cuando se puede derivar de `beneficiary_account`.',
      ),
    recipient_is_bank: z
      .boolean()
      .optional()
      .describe(
        '`true` cuando el destinatario es la propia institución receptora («Pago a Banco» en el CEP de Banxico): pagos de tarjeta de crédito, de préstamo o de servicios. `false` para una transferencia a un titular de cuenta (valor por omisión).',
      ),
    retry_policy: retryPolicySchema.optional(),
    client_ref: clientRef
      .optional()
      .describe(
        'Tu propia referencia, de 1 a 64 caracteres, sin saltos de línea. Regresa en la validación y en los webhooks, y filtra `veriko_list_validations`.',
      ),
    idempotency_key: idempotencyKeyField,
    async: asyncField,
  })
  .strict()
  .refine((value) => value.tracking_key || value.numeric_reference, {
    message: 'Envía tracking_key o numeric_reference.',
  })
  .refine(
    (value) => (value.beneficiary_account === undefined) !== (value.candidate_accounts === undefined),
    { message: 'Envía beneficiary_account o candidate_accounts, pero no las dos.' },
  );

const validateOcrShape = {
    image_base64: ocrImageBase64
      .optional()
      .describe(
        'Comprobante en base64: JPEG, PNG, WebP o un PDF de 1 a 3 páginas, hasta 12 MB. Es demasiado grande para que un modelo lo escriba; prefiere `image_url`. Si envías las dos, sólo se usa `image_url`.',
      ),
    image_url: httpsUrl
      .optional()
      .describe('URL HTTPS pública del comprobante, con los mismos formatos y el mismo límite de 12 MB. Las URL `http` se rechazan.'),
    beneficiary_account: account
      .optional()
      .describe(
        `Cuenta receptora, útil cuando el comprobante no la trae o la muestra incompleta. Obligatoria con teléfonos DiMo. ${accountPairRules.both}`,
      ),
    candidate_accounts: candidateAccounts
      .optional()
      .describe(
        'Dos o más cuentas, una de las cuales recibió la transferencia, cuando el comprobante no la muestra. Mismas reglas que en `veriko_validate_direct`.',
      ),
    sender_bank: speiBankCode
      .optional()
      .describe('Código SPEI del banco emisor, para corregir el que se leyó del comprobante, por ejemplo `40012`.'),
    receiver_bank: speiBankCode
      .optional()
      .describe('Código SPEI del banco receptor, para corregir el que se leyó del comprobante, por ejemplo `40002`.'),
    recipient_is_bank: z
      .boolean()
      .optional()
      .describe(
        '`true` cuando el destinatario es la propia institución receptora («Pago a Banco» en el CEP de Banxico), como los pagos de tarjeta de crédito o de préstamo. Por omisión `false`.',
      ),
    retry_policy: retryPolicySchema.optional(),
    client_ref: clientRef
      .optional()
      .describe('Tu propia referencia, de 1 a 64 caracteres. Regresa en la validación y en los webhooks.'),
    retain_image: z
      .boolean()
      .optional()
      .describe(
        'Por omisión `true`: la API conserva el comprobante (`veriko_get_validation_image`). Con `false` borra el archivo cuando la validación llega a un estado final.',
      ),
    idempotency_key: idempotencyKeyField,
    async: asyncField,
};

const OCR_ACCOUNT_RULE = { message: 'Envía beneficiary_account o candidate_accounts, pero no las dos.' };
const noPairedAccounts = (value: { beneficiary_account?: unknown; candidate_accounts?: unknown }) =>
  value.beneficiary_account === undefined || value.candidate_accounts === undefined;

export const validateOcrSchema = z
  .object(validateOcrShape)
  .strict()
  .refine((value) => value.image_base64 || value.image_url, {
    message: 'Envía image_base64 o image_url.',
  })
  .refine(noPairedAccounts, OCR_ACCOUNT_RULE);

/**
 * La misma herramienta cuando el servidor puede leer archivos locales (stdio,
 * `VERIKO_MCP_FILE_ROOTS`): el comprobante también puede venir de `image_path`.
 * El servidor HTTP nunca la anuncia.
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
        'Ruta absoluta de un comprobante en esta computadora: JPEG, PNG, WebP o un PDF de 1 a 3 páginas, hasta 12 MB, dentro de un directorio que el servidor permite. Prefiérela a `image_base64`; envía una sola entre `image_path`, `image_url` o `image_base64`.',
      ),
  })
  .strict()
  .refine(
    (value) => [value.image_path, value.image_url, value.image_base64].filter(Boolean).length === 1,
    { message: 'Envía exactamente una entre image_path, image_url o image_base64.' },
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
    'Validaciones retiradas (`veriko_delete_validation`). Omítelo para incluir activas y retiradas; `0` devuelve sólo las activas; `1` devuelve sólo las retiradas. Ojo: `1` no significa «incluir las retiradas».',
  );

export const validationFiltersShape = {
  status: z
    .union([validationStatus, z.array(validationStatus).min(1)])
    .optional()
    .describe(
      'Estado del ciclo de vida, un valor o una lista: queued, processing, valid, not_found, cep_unavailable, invalid, returned, failed, error.',
    ),
  type: z.enum(['direct', 'ocr']).optional().describe('`direct` para validaciones por campos, `ocr` para imágenes de comprobantes.'),
  from: date.optional().describe('Fecha de inicio (inclusive, `AAAA-MM-DD`), aplicada a la fecha de creación.'),
  to: date.optional().describe('Fecha de fin (inclusive, `AAAA-MM-DD`), aplicada a la fecha de creación.'),
  search: z
    .string()
    .max(100)
    .optional()
    .describe('Texto buscado, sin distinguir mayúsculas, en los datos enviados, normalizados y de Banxico. `%` y `_` son literales.'),
  playground: z.literal(true).optional().describe('`true` muestra sólo las validaciones del Playground (banco de pruebas).'),
  with_deleted: withdrawnScope,
  batch_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Identificador del trabajo de importación que creó las validaciones.'),
  bank: z
    .string()
    .regex(/^\d{1,5}$/)
    .optional()
    .describe('Código SPEI (1 a 5 dígitos) del banco emisor o receptor de la petición original.'),
  banks: z
    .union([
      z.string().regex(/^\d{1,5}(,\d{1,5}){0,49}$/),
      z.array(z.string().regex(/^\d{1,5}$/)).min(1).max(50),
    ])
    .optional()
    .describe('Hasta 50 códigos SPEI, como lista o separados por comas; coincide con cualquiera de ellos como emisor o receptor.'),
  amount_min: z.number().nonnegative().optional().describe('Monto mínimo, inclusive.'),
  amount_max: z.number().nonnegative().optional().describe('Monto máximo, inclusive.'),
  client_ref: clientRefFilter.optional().describe('Coincidencia exacta con el `client_ref` enviado al validar. Distingue mayúsculas y acentos.'),
  retry_state: z
    .enum(['pending', 'resolved', 'exhausted', 'cancelled'])
    .optional()
    .describe('Estado del ciclo de reintentos automáticos.'),
} as const;

export const listValidationsSchema = z
  .object({
    ...validationFiltersShape,
    page: z.number().int().positive().optional().describe('Página, desde 1. Por omisión 1.'),
    per_page: z.number().int().min(1).max(50).optional().describe('Filas por página, de 1 a 50. Por omisión 10.'),
  })
  .strict();
export const validationFiltersSchema = z.object(validationFiltersShape).strict();
export const exportValidationsSchema = z
  .object({
    ...validationFiltersShape,
    format: format.optional().describe('`csv` (por omisión) o `xlsx`.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Máximo de filas. Sólo baja el tope general de 100000.'),
  })
  .strict();

const validationIdField = uuid.describe('Identificador de la validación (UUID).');
const ifNoneMatch = z
  .string()
  .optional()
  .describe(
    '`ETag` de una respuesta anterior, enviado tal cual. Si nada cambió, el resultado es `{ not_modified: true }`, que es un éxito, no un error.',
  );

export const validationIdSchema = z.object({ validation_id: validationIdField }).strict();
export const getValidationSchema = z
  .object({ validation_id: validationIdField, if_none_match: ifNoneMatch })
  .strict();
export const downloadCepSchema = z
  .object({
    validation_id: validationIdField,
    format: z.enum(['xml', 'pdf']).default('xml').describe('`xml` (por omisión, el original de Banxico) o `pdf`.'),
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
const webhookIdField = uuid.describe('Identificador del webhook (UUID).');

export const createWebhookSchema = z
  .object({
    url: httpsUrl
      .max(2048)
      .describe('URL HTTPS receptora, de hasta 2048 caracteres. Se rechaza si resuelve a una dirección privada.'),
    events: z
      .array(webhookEvents)
      .min(1)
      .max(10)
      .describe('Eventos a los que se suscribe, de 1 a 10.'),
    description: z.string().max(255).nullable().optional().describe('Etiqueta libre, de hasta 255 caracteres. `null` la borra.'),
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
        '`true` revoca el secreto anterior de inmediato. Por omisión `false`: el secreto anterior sigue firmando 24 horas (`previous_secret_expires_at`). Usa `true` cuando el secreto anterior quedó expuesto.',
      ),
  })
  .strict();
export const updateWebhookSchema = z
  .object({
    webhook_id: webhookIdField,
    url: httpsUrl.max(2048).optional().describe('Nueva URL HTTPS receptora, de hasta 2048 caracteres.'),
    events: z.array(webhookEvents).min(1).max(10).optional().describe('Nueva lista de eventos, de 1 a 10. Reemplaza a la actual.'),
    description: z.string().max(255).nullable().optional().describe('Etiqueta nueva. `null` la quita.'),
    status: z.enum(['active', 'disabled']).optional().describe('`active` recibe entregas; `disabled` las detiene.'),
  })
  .strict()
  .refine(
    ({ webhook_id: _webhookId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos un cambio.' },
  );
const responseStatus = z.union([
  z.number().int().min(100).max(599),
  z.string().regex(/^([1-5][0-9]{2}|[1-5]xx|none)$/),
]);
const deliveryFiltersShape = {
  status: z
    .union([deliveryStatus, z.array(deliveryStatus).min(1)])
    .optional()
    .describe('Estado de la entrega: success, failed, retrying o pending.'),
  event_type: z
    .union([deliveryEvent, z.array(deliveryEvent).min(1)])
    .optional()
    .describe('Tipo de evento, o `test` para entregas sintéticas.'),
  response_status: z
    .union([responseStatus, z.array(responseStatus).min(1).max(20)])
    .optional()
    .describe('Estado HTTP con el que respondió el receptor: un código exacto (`404`), una familia (`2xx`) o `none` si no hubo respuesta. Hasta 20.'),
  validation_id: uuid.optional().describe('Sólo las entregas de esta validación.'),
  q: z.string().max(100).optional().describe('Texto buscado en el id de la entrega, la URL y la descripción del webhook, el tipo de evento y el id de la validación.'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
    .optional()
    .describe('Entregas creadas desde este momento: `AAAA-MM-DD` (medianoche UTC) o fecha y hora ISO 8601 con desfase.'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/)
    .optional()
    .describe('Entregas creadas hasta este momento: `AAAA-MM-DD` (fin de ese día, UTC) o fecha y hora ISO 8601.'),
  min_attempt: z.number().int().min(1).max(255).optional().describe('Sólo entregas con este número de intento o uno posterior. `2` deja las reintentadas.'),
  min_response_time_ms: z.number().int().min(0).max(600_000).optional().describe('Sólo entregas en las que el receptor tardó al menos estos milisegundos.'),
} as const;
const deliveriesShape = {
  page: z.number().int().positive().optional().describe('Página, desde 1.'),
  per_page: z.number().int().min(1).max(100).optional().describe('Entregas por página, de 1 a 100. Por omisión 50.'),
  ...deliveryFiltersShape,
} as const;
const endpointIds = z
  .array(uuid)
  .min(1)
  .max(20)
  .describe('Limita a estos webhooks (UUID), hasta 20. Omítelo para todos los webhooks.');
export const webhookDeliveriesSchema = z
  .object({ webhook_id: webhookIdField, ...deliveriesShape })
  .strict();
export const allDeliveriesSchema = z
  .object({ endpoint_id: endpointIds.optional(), ...deliveriesShape })
  .strict();
const exportDeliveriesShape = {
  format: format.optional().describe('`csv` (por omisión) o `xlsx`.'),
  limit: z.number().int().min(1).max(100_000).optional().describe('Máximo de filas. Sólo baja el tope general de 100000.'),
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
      .describe('Primeros 6 a 8 dígitos de la tarjeta. Nunca envíes el número completo.'),
  })
  .strict();
export const speiCalendarSchema = z
  .object({
    year: z.number().int().min(1000).max(9999).describe('Año calendario de cuatro dígitos.'),
    if_none_match: ifNoneMatch,
  })
  .strict();
export const banxicoTimeseriesSchema = z
  .object({
    metric: z
      .enum(['probe_latency', 'verdict'])
      .optional()
      .describe('`probe_latency` (por omisión): latencia promedio en milisegundos; `verdict`: veredictos de Banxico en el tiempo.'),
    window: z
      .enum(['1h', '8h', '12h', '24h', '7d'])
      .optional()
      .describe('Ventana cubierta, por omisión `24h`. `1h` agrupa por minuto y las demás por hora.'),
  })
  .strict();

const beneficiaryIdField = entityId.describe('Identificador numérico del beneficiario.');
export const digitsOf = (value: string): string => value.replace(/[ -]/g, '');
const accountNumber = z
  .string()
  .regex(/^[0-9 -]{10,40}$/, 'Usa dígitos, con espacios o guiones opcionales.')
  .refine((value) => /^\d{10,19}$/.test(digitsOf(value)), 'Usa de 10 a 19 dígitos.');
const bankCode = z.string().regex(/^\d{4,5}$/).describe('Código SPEI del banco (4 o 5 dígitos). Obligatorio para un teléfono de 10 dígitos; se ignora con CLABE y tarjetas.');
const withArchived = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe('Cuentas archivadas. Omítelo para todas; `0` devuelve sólo las activas; `1` devuelve sólo las archivadas.');

export const beneficiaryIdSchema = z.object({ beneficiary_id: beneficiaryIdField }).strict();
export const createBeneficiarySchema = z
  .object({
    account_number: accountNumber.describe(
      'CLABE (18 dígitos), tarjeta (16) o teléfono DiMo (10). Se quitan espacios y guiones.',
    ),
    bank_code: bankCode.optional(),
    label: z.string().max(100).optional().describe('Etiqueta que identifica la cuenta en la lista, de hasta 100 caracteres.'),
  })
  .strict()
  .refine((value) => digitsOf(value.account_number).length !== 10 || value.bank_code !== undefined, {
    message: 'Un teléfono de 10 dígitos requiere bank_code.',
    path: ['bank_code'],
  });
export const updateBeneficiarySchema = z
  .object({
    beneficiary_id: beneficiaryIdField,
    label: z.string().max(100).optional().describe('Etiqueta nueva, de hasta 100 caracteres.'),
    account_number: accountNumber
      .optional()
      .describe('Número de cuenta nuevo. Reemplaza al actual y vuelve a derivar el tipo y el banco. Para un teléfono, envía también `bank_code`.'),
    bank_code: bankCode.optional(),
  })
  .strict()
  .refine(
    ({ beneficiary_id: _beneficiaryId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos un cambio.' },
  )
  .refine((value) => (value.account_number === undefined || digitsOf(value.account_number).length !== 10) || value.bank_code !== undefined, {
    message: 'Un teléfono de 10 dígitos requiere bank_code.',
    path: ['bank_code'],
  });
export const listBeneficiariesSchema = z.object({ with_archived: withArchived }).strict();
export const beneficiaryLookupSchema = z
  .object({
    account: accountNumber.describe('Cuenta completa: 10 dígitos (teléfono), 16 (tarjeta) o 18 (CLABE).'),
  })
  .strict();
export const validateAccountSchema = z
  .object({
    account: z
      .string()
      .regex(/^\d{1,19}$/)
      .describe('Dígitos de la cuenta, completa o parcial: CLABE, tarjeta o teléfono, de 1 a 19 dígitos.'),
    type: z
      .enum(['clabe', 'bin'])
      .optional()
      .describe(
        'Fuerza la interpretación en lugar de detectarla por la longitud. `clabe` resuelve el banco por el prefijo aunque la CLABE esté incompleta; `bin` trata la entrada como el BIN de una tarjeta.',
      ),
  })
  .strict();
export const exportBeneficiariesSchema = z
  .object({
    format: format.optional().describe('`csv` (por omisión) o `xlsx`.'),
    with_archived: withArchived,
    limit: z.number().int().min(1).max(100_000).optional().describe('Máximo de filas. Sólo baja el tope general de 100000.'),
  })
  .strict();
export const importTemplateSchema = z
  .object({
    format: z.enum(['csv', 'xlsx', 'xls', 'txt', 'json']).describe('Formato de la plantilla. `json` tiene la misma forma que el archivo que lee la importación.'),
  })
  .strict();
export const createImportSchema = z
  .object({
    file_base64: beneficiaryImportBase64.describe('Contenido del archivo en base64, hasta 20 MB: CSV, XLS, XLSX, TXT, JSON o PDF.'),
    filename: z
      .string()
      .min(1)
      .max(255)
      .describe('Nombre del archivo con su extensión (`.csv`, `.xlsx`...). La extensión le indica el formato a la API.'),
    parse_mode: z
      .enum(['template', 'free'])
      .default('template')
      .describe('`template` espera los encabezados canónicos; `free` deja que el servicio infiera la estructura.'),
  })
  .strict();
const importParseMode = z
  .enum(['template', 'free'])
  .default('template')
  .describe('`template` espera los encabezados canónicos; `free` deja que el servicio infiera la estructura.');

/**
 * La misma herramienta cuando el servidor puede leer archivos locales (stdio, `VERIKO_MCP_FILE_ROOTS`):
 * el archivo también puede venir de `file_path`, y entonces `filename` toma por omisión su nombre.
 */
export const createImportLocalSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Ruta absoluta del archivo en esta computadora, de hasta 20 MB, dentro de un directorio que el servidor permite: CSV, XLS, XLSX, TXT, JSON o PDF. Prefiérela a `file_base64`. `filename` toma por omisión el nombre del archivo.',
      ),
    file_base64: beneficiaryImportBase64
      .optional()
      .describe('Contenido del archivo en base64, hasta 20 MB. Envíalo o envía `file_path`, no los dos.'),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Nombre del archivo con su extensión (`.csv`, `.xlsx`...). Obligatorio con `file_base64`.'),
    parse_mode: importParseMode,
  })
  .strict()
  .refine((value) => (value.file_path === undefined) !== (value.file_base64 === undefined), {
    message: 'Envía exactamente uno entre file_path o file_base64.',
  })
  .refine((value) => value.file_path !== undefined || value.filename !== undefined, {
    message: 'Envía filename con file_base64.',
  });

const importIdField = entityId.describe('Identificador numérico del trabajo de importación.');
export const importIdSchema = z.object({ import_id: importIdField }).strict();
export const importPreviewSchema = z
  .object({
    import_id: importIdField,
    page: z.number().int().positive().optional().describe('Página, desde 1.'),
    per_page: z.number().int().min(1).max(100).optional().describe('Filas por página, de 1 a 100. Por omisión 25.'),
    buckets: z
      .array(z.enum(['valid', 'correctable', 'fatal', 'duplicate_account', 'duplicate_alias']))
      .min(1)
      .optional()
      .describe('Clases de fila a incluir: `valid` se guarda tal cual, `correctable` necesita una corrección (`veriko_patch_beneficiary_import_row`), `fatal` no se puede guardar y los duplicados chocan con cuentas o etiquetas existentes.'),
  })
  .strict();
export const editImportRowSchema = z
  .object({
    import_id: importIdField,
    row_id: entityId.describe('Identificador numérico de la fila dentro de la importación.'),
    parsed_account: z
      .string()
      .max(32)
      .regex(/^[0-9 -]{0,32}$/)
      .optional()
      .describe('Número de cuenta corregido, de hasta 32 caracteres de dígitos. Se normaliza otra vez al reprocesar.'),
    parsed_label: z.string().max(100).optional().describe('Etiqueta corregida. Un `=`, `+`, `-` o `@` al inicio se guarda con apóstrofo para que las hojas de cálculo no lo lean como fórmula.'),
    parsed_account_type: z.enum(['clabe', 'card', 'phone']).optional().describe('Tipo de cuenta corregido.'),
    parsed_bank_code: z.string().regex(/^\d{4,5}$/).optional().describe('Código SPEI del banco corregido, útil para cuentas de teléfono.'),
    parsed_bank_name: z.string().max(50).optional().describe('Nombre del banco corregido.'),
  })
  .strict()
  .refine(
    ({ import_id: _importId, row_id: _rowId, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'Indica al menos una corrección.' },
  );
export const importRowSchema = z
  .object({ import_id: importIdField, row_id: entityId.describe('Identificador numérico de la fila dentro de la importación.') })
  .strict();

export const usageHistorySchema = z
  .object({ months: z.number().int().min(1).max(24).optional().describe('Meses a incluir, hacia atrás desde hoy. Por omisión 6.') })
  .strict();
export const usageBreakdownSchema = z
  .object({
    period: z
      .union([z.literal('current'), month])
      .optional()
      .describe('`current` para el mes en curso, o `AAAA-MM`.'),
  })
  .strict();
export const usageHeatmapSchema = z
  .object({ days: z.number().int().min(1).max(90).optional().describe('Días a incluir. Por omisión 30.') })
  .strict();
export const exportUsageSchema = z
  .object({
    format: format.optional().describe('`csv` (por omisión) o `xlsx`.'),
    from: date.optional().describe('Fecha de inicio (inclusive, `AAAA-MM-DD`).'),
    to: date.optional().describe('Fecha de fin (inclusive, `AAAA-MM-DD`).'),
    limit: z.number().int().min(1).optional().describe('Máximo de filas. Sólo baja el tope por omisión de 100000.'),
  })
  .strict();
export const updateMyRetryPolicySchema = z
  .object({ retry_policy: retryPolicySchema, idempotency_key: idempotencyKeyField })
  .strict();
export const dashboardSchema = z
  .object({ limit: z.number().int().min(1).max(10).optional().describe('Validaciones recientes a devolver, de 1 a 10. Por omisión 5.') })
  .strict();
export const trendsSchema = z
  .object({
    range: z.enum(['24h', '7d', '30d', '90d']).optional().describe('Ventana de la serie. Por omisión `7d`.'),
    metric: z.enum(['volume', 'latency']).optional().describe('`volume` (por omisión) cuenta validaciones; `latency` devuelve percentiles del tiempo de procesamiento.'),
  })
  .strict();
export const topBanksSchema = z
  .object({
    metric: z.enum(['volume', 'errors']).optional().describe('Ordena por `volume` (por omisión) o por tasa de error (`errors`).'),
    limit: z.number().int().positive().max(50).optional().describe('Máximo de bancos, hasta 50. Por omisión 10.'),
  })
  .strict();
export const topBeneficiariesSchema = z
  .object({ limit: z.number().int().positive().max(50).optional().describe('Máximo de beneficiarios, hasta 50. Por omisión 10.') })
  .strict();

const financeMonth = month.describe('Mes a reportar, `AAAA-MM`.');
const financeBase = { month: financeMonth } as const;
const financeLimit = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .optional()
  .describe('Tope de filas para `csv` y `xlsx`. No aplica al PDF, que tiene su propio tope de 1000 filas.');
export const financeSummarySchema = z.object(financeBase).strict();
export const financeStatementSchema = z
  .object({
    ...financeBase,
    format: z.enum(['pdf', 'xlsx', 'csv', 'html']).default('pdf').describe('Formato del archivo. Por omisión `pdf`.'),
  })
  .strict();
export const financePreviewSchema = z
  .object({
    ...financeBase,
    format: z
      .enum(['csv', 'xlsx', 'pdf', 'preview'])
      .default('preview')
      .describe('`preview` (por omisión aquí) devuelve las primeras 20 filas como datos estructurados; `csv`, `xlsx` y `pdf` devuelven un archivo.'),
    limit: financeLimit,
  })
  .strict();
export const financeAccountingSchema = z
  .object({
    ...financeBase,
    format: z
      .enum(['csv', 'xlsx', 'pdf', 'preview'])
      .default('preview')
      .describe('`preview` (por omisión aquí) devuelve las primeras 20 filas como datos estructurados; `csv`, `xlsx` y `pdf` devuelven un archivo.'),
    limit: financeLimit,
    decimal: z
      .enum(['comma', 'dot'])
      .optional()
      .describe('Separador decimal: `comma` (por omisión, `1.234,56`) o `dot` (`1,234.56`).'),
  })
  .strict();
const rangeFrom = date.describe('Fecha de inicio (inclusive, `AAAA-MM-DD`).');
const rangeTo = date.describe('Fecha de fin (inclusive, `AAAA-MM-DD`). No puede ser anterior a `from`.');
export const financeCepsSchema = z.object({ from: rangeFrom, to: rangeTo }).strict();
export const financeCepExportCreateSchema = z
  .object({ from: rangeFrom, to: rangeTo, idempotency_key: idempotencyKeyField })
  .strict();
export const financeCepExportIdSchema = z
  .object({ export_id: uuid.describe('Identificador de la exportación de CEP (UUID).') })
  .strict();

const timeoutSeconds = z
  .number()
  .int()
  .min(1)
  .max(40)
  .optional()
  .describe(
    'Espera máxima de esta llamada, en segundos, de 1 a 40. Por omisión 25. Si el recurso no está en un estado final para entonces, el resultado dice `waiting: true`; vuelve a llamar a la herramienta.',
  );
export const waitForValidationSchema = z
  .object({ validation_id: validationIdField, timeout_seconds: timeoutSeconds })
  .strict();
export const waitForCepExportSchema = z
  .object({ export_id: z.string().uuid().describe('Identificador de la exportación de CEP (UUID).'), timeout_seconds: timeoutSeconds })
  .strict();
export const waitForImportSchema = z
  .object({ import_id: importIdField, timeout_seconds: timeoutSeconds })
  .strict();

/** Los estados tras los cuales una validación deja de consultarse (el `x-terminal-values` del spec). */
export const VALIDATION_TERMINAL_STATUSES: readonly string[] = TERMINAL_STATUSES;
/** Los estados de exportación tras los cuales se deja de consultar (el `x-terminal-values` del spec). */
export const CEP_EXPORT_TERMINAL_STATUSES = ['ready', 'failed', 'expired'] as const;
