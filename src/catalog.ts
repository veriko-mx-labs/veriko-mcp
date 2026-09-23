import type { Veriko } from '@veriko-mx/sdk-runtime';
import type { z } from 'zod';

import { type Family, type Profile, type Risk, riskAllowed } from './config.js';
import { stableIdempotencyKey } from './idempotency.js';
import {
  allDeliveriesSchema,
  banxicoTimeseriesSchema,
  banksSchema,
  beneficiaryIdSchema,
  beneficiaryLookupSchema,
  binSchema,
  createBeneficiarySchema,
  createImportSchema,
  createWebhookSchema,
  dashboardSchema,
  downloadCepSchema,
  editImportRowSchema,
  emptySchema,
  exportAllDeliveriesSchema,
  exportBeneficiariesSchema,
  exportUsageSchema,
  exportValidationsSchema,
  exportWebhookDeliveriesSchema,
  financeAccountingSchema,
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
  topBanksSchema,
  topBeneficiariesSchema,
  trendsSchema,
  updateBeneficiarySchema,
  updateMyRetryPolicySchema,
  updateWebhookSchema,
  usageBreakdownSchema,
  usageHeatmapSchema,
  usageHistorySchema,
  validateDirectSchema,
  validateOcrSchema,
  validationFiltersSchema,
  validationIdSchema,
  validationIdempotentSchema,
  validationRetryPolicySchema,
  webhookDeliveriesSchema,
  webhookIdSchema,
} from './schemas.js';

type Cost = 'none' | 'included' | 'quota';
type InputSchema = z.ZodType<Record<string, unknown>>;

export interface ToolDefinition {
  operationId: string;
  name: string;
  title: string;
  description: string;
  family: Family;
  risk: Risk;
  cost: Cost;
  core: boolean;
  inputSchema: InputSchema;
  invoke(client: Veriko, args: Record<string, unknown>): Promise<unknown>;
}

interface DefinitionOptions<T extends InputSchema> {
  operationId: string;
  title: string;
  description: string;
  family: Family;
  risk?: Risk;
  cost?: Cost;
  core?: boolean;
  inputSchema: T;
  invoke(client: Veriko, args: z.output<T>): Promise<unknown>;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * El coste vive en `_meta`, que el modelo no lee. La descripción sí la lee al
 * elegir, así que el aviso va ahí. Un bucle de un agente puede agotar una
 * cuota mensual en minutos.
 */
export const AVISO_DE_CUOTA =
  'Cada validación consume cuota del plan del usuario y se descuenta al aceptar la petición.';

function describe(description: string, cost: Cost): string {
  return cost === 'quota' ? `${description} ${AVISO_DE_CUOTA}` : description;
}

function define<T extends InputSchema>(options: DefinitionOptions<T>): ToolDefinition {
  const cost = options.cost ?? 'included';
  return {
    operationId: options.operationId,
    name: `veriko_${snakeCase(options.operationId)}`,
    title: options.title,
    description: describe(options.description, cost),
    family: options.family,
    risk: options.risk ?? 'read',
    cost,
    core: options.core ?? false,
    inputSchema: options.inputSchema,
    invoke: (client, args) => options.invoke(client, options.inputSchema.parse(args)),
  };
}

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  define({
    operationId: 'validateDirect',
    title: 'Validar una transferencia SPEI',
    description: 'Valida datos de una transferencia contra el CEP de Banxico.',
    family: 'validations',
    risk: 'write',
    cost: 'quota',
    core: true,
    inputSchema: validateDirectSchema,
    async invoke(client, args) {
      const { async, idempotencyKey: _provided, ...params } = args;
      const idempotencyKey = stableIdempotencyKey('validateDirect', args);
      return async
        ? client.validations.enqueue({ ...params, idempotencyKey })
        : client.validations.validate({ ...params, idempotencyKey });
    },
  }),
  define({
    operationId: 'validateOcr',
    title: 'Validar un comprobante por OCR',
    description: 'Extrae y valida una transferencia desde una imagen o URL HTTPS.',
    family: 'validations',
    risk: 'write',
    cost: 'quota',
    core: true,
    inputSchema: validateOcrSchema,
    async invoke(client, args) {
      const { async, imageBase64, idempotencyKey: _provided, ...rest } = args;
      const params = {
        ...rest,
        ...(imageBase64 ? { image: Buffer.from(imageBase64, 'base64') } : {}),
        idempotencyKey: stableIdempotencyKey('validateOcr', args),
      };
      return async ? client.validations.enqueueOcr(params) : client.validations.validateOcr(params);
    },
  }),
  define({
    operationId: 'listValidations',
    title: 'Listar validaciones',
    description: 'Lista validaciones con filtros y paginación.',
    family: 'validations',
    core: true,
    inputSchema: listValidationsSchema,
    invoke: (client, args) => client.validations.list(args),
  }),
  define({
    operationId: 'getValidation',
    title: 'Consultar una validación',
    description: 'Obtiene una validación y su ETag por identificador.',
    family: 'validations',
    core: true,
    inputSchema: getValidationSchema,
    invoke(client, { validationId, ...options }) {
      return client.validations.get(validationId, options);
    },
  }),
  define({
    operationId: 'downloadCep',
    title: 'Descargar el CEP',
    description: 'Obtiene el comprobante oficial de Banxico en XML o PDF como recurso MCP.',
    family: 'validations',
    core: true,
    inputSchema: downloadCepSchema,
    invoke(client, { validationId, ...options }) {
      return client.validations.cep(validationId, options);
    },
  }),
  define({
    operationId: 'getValidationImage',
    title: 'Descargar imagen de validación',
    description: 'Obtiene la imagen original de una validación OCR como recurso MCP.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validationId }) => client.validations.image(validationId),
  }),
  define({
    operationId: 'validationStats',
    title: 'Consultar estadísticas de validaciones',
    description: 'Resume validaciones aplicando los mismos filtros del listado.',
    family: 'validations',
    inputSchema: validationFiltersSchema,
    invoke: (client, args) => client.validations.stats(args),
  }),
  define({
    operationId: 'exportValidations',
    title: 'Exportar validaciones',
    description: 'Exporta el historial filtrado como recurso CSV o XLSX.',
    family: 'validations',
    inputSchema: exportValidationsSchema,
    invoke: (client, args) => client.validations.export(args),
  }),
  define({
    operationId: 'listValidationRetryAttempts',
    title: 'Listar intentos de una validación',
    description: 'Lista los intentos del ciclo de reintentos automáticos.',
    family: 'validations',
    inputSchema: validationIdSchema,
    invoke: (client, { validationId }) => client.validations.retryAttempts(validationId),
  }),
  define({
    operationId: 'updateValidationRetryPolicy',
    title: 'Cambiar reintentos de una validación',
    description: 'Actualiza la política de reintentos de una validación de forma idempotente.',
    family: 'validations',
    risk: 'write',
    inputSchema: validationRetryPolicySchema,
    invoke(client, args) {
      return client.validations.setRetryPolicy(args.validationId, args.policy, {
        idempotencyKey: stableIdempotencyKey('updateValidationRetryPolicy', args),
      });
    },
  }),
  define({
    operationId: 'cancelValidationRetries',
    title: 'Cancelar reintentos de una validación',
    description: 'Cancela los reintentos pendientes de forma idempotente.',
    family: 'validations',
    risk: 'destructive',
    inputSchema: validationIdempotentSchema,
    invoke(client, args) {
      return client.validations.cancelRetries(args.validationId, {
        idempotencyKey: stableIdempotencyKey('cancelValidationRetries', args),
      });
    },
  }),
  define({
    operationId: 'deleteValidation',
    title: 'Retirar una validación',
    description: 'Retira una validación del historial visible.',
    family: 'validations',
    risk: 'destructive',
    inputSchema: validationIdSchema,
    invoke: (client, { validationId }) => client.validations.delete(validationId),
  }),
  define({
    operationId: 'sendCepToTelegram',
    title: 'Enviar CEP a Telegram',
    description: 'Solicita el envío del CEP mediante la integración de Telegram configurada.',
    family: 'validations',
    risk: 'write',
    inputSchema: validationIdSchema,
    invoke: (client, { validationId }) => client.validations.sendCepToTelegram(validationId),
  }),

  define({
    operationId: 'createWebhook',
    title: 'Crear webhook',
    description: 'Registra un endpoint HTTPS y sus eventos.',
    family: 'webhooks',
    risk: 'write',
    inputSchema: createWebhookSchema,
    invoke: (client, args) =>
      client.webhooks.create(args as Parameters<Veriko['webhooks']['create']>[0]),
  }),
  define({
    operationId: 'listWebhooks',
    title: 'Listar webhooks',
    description: 'Lista los endpoints webhook de la cuenta.',
    family: 'webhooks',
    inputSchema: emptySchema,
    invoke: (client) => client.webhooks.list(),
  }),
  define({
    operationId: 'updateWebhook',
    title: 'Actualizar webhook',
    description: 'Cambia URL, eventos, etiqueta o estado de un webhook.',
    family: 'webhooks',
    risk: 'write',
    inputSchema: updateWebhookSchema,
    invoke(client, { webhookId, ...changes }) {
      return client.webhooks.update(webhookId, changes);
    },
  }),
  define({
    operationId: 'deleteWebhook',
    title: 'Eliminar webhook',
    description: 'Elimina un endpoint webhook.',
    family: 'webhooks',
    risk: 'destructive',
    inputSchema: webhookIdSchema,
    invoke: (client, { webhookId }) => client.webhooks.delete(webhookId),
  }),
  define({
    operationId: 'sendWebhookTest',
    title: 'Probar webhook',
    description: 'Envía un evento sintético al endpoint webhook.',
    family: 'webhooks',
    risk: 'write',
    inputSchema: webhookIdSchema,
    invoke: (client, { webhookId }) => client.webhooks.test(webhookId),
  }),
  define({
    operationId: 'regenerateWebhookSecret',
    title: 'Rotar secreto de webhook',
    description: 'Invalida el secreto anterior y devuelve uno nuevo.',
    family: 'webhooks',
    risk: 'destructive',
    inputSchema: webhookIdSchema,
    invoke: (client, { webhookId }) => client.webhooks.regenerateSecret(webhookId),
  }),
  define({
    operationId: 'listWebhookDeliveries',
    title: 'Listar entregas de webhook',
    description: 'Lista las entregas de un endpoint webhook.',
    family: 'webhooks',
    inputSchema: webhookDeliveriesSchema,
    invoke(client, { webhookId, ...params }) {
      return client.webhooks.deliveries(webhookId, params);
    },
  }),
  define({
    operationId: 'listAllDeliveries',
    title: 'Listar todas las entregas',
    description: 'Lista entregas de todos los webhooks con filtros.',
    family: 'webhooks',
    inputSchema: allDeliveriesSchema,
    invoke: (client, args) => client.webhooks.deliveries(args),
  }),
  define({
    operationId: 'exportWebhookDeliveries',
    title: 'Exportar entregas de webhook',
    description: 'Exporta las entregas de un endpoint como recurso CSV o XLSX.',
    family: 'webhooks',
    inputSchema: exportWebhookDeliveriesSchema,
    invoke(client, { webhookId, ...params }) {
      return client.webhooks.exportDeliveries(webhookId, params);
    },
  }),
  define({
    operationId: 'exportAllDeliveries',
    title: 'Exportar todas las entregas',
    description: 'Exporta entregas consolidadas como recurso CSV o XLSX.',
    family: 'webhooks',
    inputSchema: exportAllDeliveriesSchema,
    invoke: (client, args) => client.webhooks.exportDeliveries(args),
  }),

  define({
    operationId: 'listBanks',
    title: 'Listar bancos SPEI',
    description: 'Obtiene el catálogo de participantes SPEI.',
    family: 'catalog',
    inputSchema: banksSchema,
    invoke: (client, args) => client.catalog.banks(args),
  }),
  define({
    operationId: 'lookupBin',
    title: 'Resolver BIN de tarjeta',
    description: 'Identifica el banco emisor a partir del BIN.',
    family: 'catalog',
    inputSchema: binSchema,
    invoke: (client, { bin }) => client.catalog.binLookup(bin),
  }),
  define({
    operationId: 'banxicoPublicStatus',
    title: 'Consultar estado de Banxico',
    description: 'Consulta el estado público del servicio CEP de Banxico.',
    family: 'catalog',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.catalog.banxicoStatus(),
  }),
  define({
    operationId: 'banxicoPublicTimeseries',
    title: 'Consultar serie de Banxico',
    description: 'Obtiene una serie pública de disponibilidad, latencia o veredictos.',
    family: 'catalog',
    cost: 'none',
    inputSchema: banxicoTimeseriesSchema,
    invoke: (client, args) => client.catalog.banxicoTimeseries(args),
  }),

  define({
    operationId: 'createBeneficiary',
    title: 'Crear beneficiario',
    description: 'Guarda una cuenta beneficiaria.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: createBeneficiarySchema,
    invoke: (client, args) => client.beneficiaries.create(args),
  }),
  define({
    operationId: 'listBeneficiaries',
    title: 'Listar beneficiarios',
    description: 'Lista las cuentas beneficiarias guardadas.',
    family: 'beneficiaries',
    inputSchema: listBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.list(args),
  }),
  define({
    operationId: 'updateBeneficiary',
    title: 'Actualizar beneficiario',
    description: 'Cambia etiqueta, cuenta o banco de un beneficiario.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: updateBeneficiarySchema,
    invoke(client, { beneficiaryId, ...changes }) {
      return client.beneficiaries.update(beneficiaryId, changes);
    },
  }),
  define({
    operationId: 'deleteBeneficiary',
    title: 'Archivar beneficiario',
    description: 'Archiva una cuenta beneficiaria.',
    family: 'beneficiaries',
    risk: 'destructive',
    inputSchema: beneficiaryIdSchema,
    invoke: (client, { beneficiaryId }) => client.beneficiaries.delete(beneficiaryId),
  }),
  define({
    operationId: 'lookupBeneficiaryAccount',
    title: 'Buscar cuenta beneficiaria',
    description: 'Resuelve una cuenta dentro de los beneficiarios guardados.',
    family: 'beneficiaries',
    inputSchema: beneficiaryLookupSchema,
    invoke: (client, { account }) => client.beneficiaries.lookup(account),
  }),
  define({
    operationId: 'exportBeneficiaries',
    title: 'Exportar beneficiarios',
    description: 'Exporta beneficiarios como recurso CSV o XLSX.',
    family: 'beneficiaries',
    inputSchema: exportBeneficiariesSchema,
    invoke: (client, args) => client.beneficiaries.export(args),
  }),
  define({
    operationId: 'downloadBeneficiaryImportTemplate',
    title: 'Descargar plantilla de beneficiarios',
    description: 'Obtiene la plantilla de importación como recurso MCP.',
    family: 'beneficiaries',
    inputSchema: importTemplateSchema,
    invoke: (client, args) => client.beneficiaries.importTemplate(args),
  }),
  define({
    operationId: 'createBeneficiaryImport',
    title: 'Iniciar importación de beneficiarios',
    description: 'Sube un archivo base64 para preparar una importación.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: createImportSchema,
    invoke(client, { fileBase64, ...options }) {
      return client.beneficiaries.importStart(Buffer.from(fileBase64, 'base64'), options);
    },
  }),
  define({
    operationId: 'getBeneficiaryImport',
    title: 'Consultar importación de beneficiarios',
    description: 'Obtiene el estado y los contadores de una importación.',
    family: 'beneficiaries',
    inputSchema: importIdSchema,
    invoke: (client, { importId }) => client.beneficiaries.importStatus(importId),
  }),
  define({
    operationId: 'cancelBeneficiaryImport',
    title: 'Cancelar importación de beneficiarios',
    description: 'Cancela una importación que aún no fue confirmada.',
    family: 'beneficiaries',
    risk: 'destructive',
    inputSchema: importIdSchema,
    invoke: (client, { importId }) => client.beneficiaries.importCancel(importId),
  }),
  define({
    operationId: 'getBeneficiaryImportPreview',
    title: 'Revisar importación de beneficiarios',
    description: 'Lista las filas clasificadas de la vista previa.',
    family: 'beneficiaries',
    inputSchema: importPreviewSchema,
    invoke(client, { importId, ...params }) {
      return client.beneficiaries.importPreview(importId, params);
    },
  }),
  define({
    operationId: 'patchBeneficiaryImportRow',
    title: 'Corregir fila de importación',
    description: 'Corrige y reprocesa una fila de la vista previa.',
    family: 'beneficiaries',
    risk: 'write',
    inputSchema: editImportRowSchema,
    invoke(client, { importId, rowId, ...changes }) {
      return client.beneficiaries.importEditRow(importId, rowId, changes);
    },
  }),
  define({
    operationId: 'deleteBeneficiaryImportRow',
    title: 'Quitar fila de importación',
    description: 'Elimina una fila de la vista previa.',
    family: 'beneficiaries',
    risk: 'destructive',
    inputSchema: importRowSchema,
    invoke: (client, { importId, rowId }) =>
      client.beneficiaries.importRemoveRow(importId, rowId),
  }),
  define({
    operationId: 'commitBeneficiaryImport',
    title: 'Confirmar importación de beneficiarios',
    description: 'Crea o actualiza beneficiarios a partir de las filas válidas.',
    family: 'beneficiaries',
    risk: 'destructive',
    inputSchema: importIdSchema,
    invoke: (client, { importId }) => client.beneficiaries.importCommit(importId),
  }),

  define({
    operationId: 'getUsageSummary',
    title: 'Consultar consumo',
    description: 'Obtiene el resumen de consumo del periodo actual.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.summary(),
  }),
  define({
    operationId: 'getUsageHistory',
    title: 'Consultar historial de consumo',
    description: 'Obtiene el consumo mensual histórico.',
    family: 'usage',
    inputSchema: usageHistorySchema,
    invoke: (client, args) => client.usage.history(args),
  }),
  define({
    operationId: 'getUsageBreakdown',
    title: 'Desglosar consumo',
    description: 'Desglosa el consumo por tipo de operación.',
    family: 'usage',
    inputSchema: usageBreakdownSchema,
    invoke: (client, args) => client.usage.breakdown(args),
  }),
  define({
    operationId: 'getUsageLimits',
    title: 'Consultar límites',
    description: 'Obtiene cuota, límites y disponibilidad de la cuenta.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.limits(),
  }),
  define({
    operationId: 'getUsageHeatmap',
    title: 'Consultar mapa de consumo',
    description: 'Obtiene el consumo diario para el rango solicitado.',
    family: 'usage',
    inputSchema: usageHeatmapSchema,
    invoke: (client, args) => client.usage.heatmap(args),
  }),
  define({
    operationId: 'getApiUsage',
    title: 'Consultar uso de API',
    description: 'Obtiene la actividad reciente de la API.',
    family: 'usage',
    inputSchema: emptySchema,
    invoke: (client) => client.usage.apiUsage(),
  }),
  define({
    operationId: 'exportApiUsage',
    title: 'Exportar uso de API',
    description: 'Exporta la actividad de API como recurso CSV o XLSX.',
    family: 'usage',
    inputSchema: exportUsageSchema,
    invoke: (client, args) => client.usage.export(args),
  }),

  define({
    operationId: 'myProfile',
    title: 'Consultar perfil propio',
    description: 'Obtiene los datos del integrador autenticado.',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.myProfile(),
  }),
  define({
    operationId: 'getMyRetryPolicy',
    title: 'Consultar política de reintentos',
    description: 'Obtiene la política predeterminada de la cuenta.',
    family: 'account',
    inputSchema: emptySchema,
    invoke: (client) => client.account.getMyRetryPolicy(),
  }),
  define({
    operationId: 'updateMyRetryPolicy',
    title: 'Cambiar política de reintentos',
    description: 'Actualiza la política predeterminada de forma idempotente.',
    family: 'account',
    risk: 'write',
    inputSchema: updateMyRetryPolicySchema,
    invoke(client, args) {
      return client.account.updateMyRetryPolicy(args.policy, {
        idempotencyKey: stableIdempotencyKey('updateMyRetryPolicy', args),
      });
    },
  }),
  define({
    operationId: 'getDashboardSummary',
    title: 'Consultar resumen operativo',
    description: 'Obtiene los indicadores principales del panel.',
    family: 'dashboard',
    inputSchema: dashboardSchema,
    invoke: (client, args) => client.dashboard.getSummary(args),
  }),
  define({
    operationId: 'listPublicPlans',
    title: 'Listar planes públicos',
    description: 'Lista los planes públicos sin requerir clave de API.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.listPublic(),
  }),
  define({
    operationId: 'getPublicPlanComparison',
    title: 'Comparar planes públicos',
    description: 'Compara capacidades y precios públicos sin requerir clave de API.',
    family: 'plans',
    cost: 'none',
    inputSchema: emptySchema,
    invoke: (client) => client.plans.getPublicPlanComparison(),
  }),
  define({
    operationId: 'getUserInsightsOverview',
    title: 'Consultar resumen de insights',
    description: 'Obtiene métricas agregadas de la cuenta.',
    family: 'insights',
    inputSchema: emptySchema,
    invoke: (client) => client.insights.getOverview(),
  }),
  define({
    operationId: 'getUserInsightsTrends',
    title: 'Consultar tendencias',
    description: 'Obtiene tendencias de volumen o latencia.',
    family: 'insights',
    inputSchema: trendsSchema,
    invoke: (client, args) => client.insights.getTrends(args),
  }),
  define({
    operationId: 'getUserInsightsTopBanks',
    title: 'Consultar bancos principales',
    description: 'Ordena bancos por volumen o errores.',
    family: 'insights',
    inputSchema: topBanksSchema,
    invoke: (client, args) => client.insights.getTopBanks(args),
  }),
  define({
    operationId: 'getUserInsightsTopBeneficiaries',
    title: 'Consultar beneficiarios principales',
    description: 'Obtiene los beneficiarios con mayor actividad.',
    family: 'insights',
    inputSchema: topBeneficiariesSchema,
    invoke: (client, args) => client.insights.getTopBeneficiaries(args),
  }),

  define({
    operationId: 'getFinanceSummary',
    title: 'Consultar resumen financiero',
    description: 'Obtiene el resumen financiero de un mes.',
    family: 'finance',
    inputSchema: financeSummarySchema,
    invoke: (client, args) => client.finance.getSummary(args),
  }),
  define({
    operationId: 'getFinanceStatement',
    title: 'Descargar estado financiero',
    description: 'Genera el estado financiero mensual como recurso MCP.',
    family: 'finance',
    inputSchema: financeStatementSchema,
    invoke: (client, args) => client.finance.getStatement(args),
  }),
  define({
    operationId: 'getFinanceMonthly',
    title: 'Consultar movimientos mensuales',
    description: 'Devuelve vista previa estructurada por omisión o un recurso descargable.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getMonthly(args),
  }),
  define({
    operationId: 'getFinanceCounterparties',
    title: 'Consultar contrapartes',
    description: 'Devuelve vista previa estructurada por omisión o un recurso descargable.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getCounterparties(args),
  }),
  define({
    operationId: 'getFinanceByBank',
    title: 'Consultar finanzas por banco',
    description: 'Devuelve vista previa estructurada por omisión o un recurso descargable.',
    family: 'finance',
    inputSchema: financePreviewSchema,
    invoke: (client, args) => client.finance.getByBank(args),
  }),
  define({
    operationId: 'getFinanceAccounting',
    title: 'Consultar reporte contable',
    description: 'Devuelve vista previa estructurada por omisión o un recurso descargable.',
    family: 'finance',
    inputSchema: financeAccountingSchema,
    invoke: (client, args) => client.finance.getAccounting(args),
  }),
  define({
    operationId: 'getFinanceCeps',
    title: 'Descargar CEP financieros',
    description: 'Genera un paquete de CEP para el rango indicado como recurso MCP.',
    family: 'finance',
    inputSchema: financeCepsSchema,
    invoke: (client, args) => client.finance.getCeps(args),
  }),
  define({
    operationId: 'billingGetSubscription',
    title: 'Consultar suscripción',
    description: 'Obtiene el estado de la suscripción activa.',
    family: 'billing',
    inputSchema: emptySchema,
    invoke: (client) => client.billing.getSubscription(),
  }),
] as const;

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
