/**
 * Escenarios para el catálogo.
 *
 * Cada escenario es independiente y comprobable, y lleva el camino que espera:
 *
 * - Independiente: ninguno depende de que otro se haya ejecutado antes, así que
 *   pueden correr en cualquier orden y de forma aislada.
 * - Ficticio: corren contra `fake-api.ts`, nunca contra la API real, así que una
 *   corrida con un modelo real no gasta validaciones. Los escenarios de escritura (`W*`) y
 *   los de error (`X*`) recorren los mismos caminos de código que los de lectura.
 * - Comprobable: `check` decide con una regla, no con un juicio de similitud. Una
 *   pregunta que no se puede comprobar así no entra.
 * - Con camino esperado: se mide el camino además del resultado. Una respuesta
 *   correcta por la herramienta equivocada es una respuesta correcta frágil.
 */
import {
  CEP_EXPORT_ID,
  INVALID_TRACKING_KEY,
  NEW_VALIDATION_ID,
  QUEUED_VALIDATION_ID,
  QUOTA_TRACKING_KEY,
} from './fake-api.js';

export interface Step {
  /** Operación del catálogo que responde esta parte de la pregunta. */
  operation: string;
  /** Argumentos del camino de referencia; un modelo los deduce por su cuenta. */
  arguments: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  question: string;
  /** El perfil más pequeño que hace visibles las herramientas necesarias. */
  profile: string;
  /** Nivel de riesgo que necesita el escenario. */
  risk: 'read' | 'write' | 'destructive';
  /**
   * El cliente declara la capacidad de elicitation y responde con esta acción a la
   * pregunta que el servidor hace antes de una herramienta destructiva.
   */
  confirms?: 'accept' | 'decline';
  /** Llamadas al SDK que el camino de referencia no debe hacer. */
  forbiddenMethods?: readonly string[];
  /** Llamadas a herramientas del camino de referencia, en orden. */
  steps: readonly Step[];
  /** Llamadas al SDK que hace el camino de referencia. */
  expectedMethods: readonly string[];
  /** Verdad de referencia, derivada de los datos ficticios. */
  answer: string;
  /** El camino de referencia termina en un resultado de error que el modelo tiene que leer. */
  expectsError?: boolean;
  /** Regla que decide si una respuesta de texto libre es correcta. */
  check(text: string): boolean;
}

const contains =
  (...fragments: readonly string[]) =>
  (text: string): boolean => {
    const plain = text.toLowerCase();
    return fragments.every((fragment) => plain.includes(fragment.toLowerCase()));
  };

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'E01-status-of-a-validation',
    question: '¿En qué quedó la validación 2f4a7c91-1111-4a11-8a11-000000000001?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '2f4a7c91-1111-4a11-8a11-000000000001' } }],
    expectedMethods: ['validations.get'],
    answer: 'verified',
    check: contains('verified'),
  },
  {
    id: 'E02-returned-verdict',
    question: '¿La transferencia 7b1e30d5-2222-4a22-8a22-000000000002 llegó a su destino?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '7b1e30d5-2222-4a22-8a22-000000000002' } }],
    expectedMethods: ['validations.get'],
    answer: 'No: su veredicto es returned, el dinero regresó al ordenante.',
    check: contains('returned'),
  },
  {
    id: 'E03-tell-not-found-apart',
    question: '¿Por qué falló la validación 9c5d24ab-3333-4a33-8a33-000000000003?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '9c5d24ab-3333-4a33-8a33-000000000003' } }],
    expectedMethods: ['validations.get'],
    answer: 'Su veredicto es not_found: Banxico no encontró el CEP.',
    check: contains('not_found'),
  },
  {
    id: 'E04-count-by-status',
    question: '¿Cuántas validaciones tengo en el estado queued?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'listValidations', arguments: { status: 'queued' } }],
    expectedMethods: ['validations.list'],
    answer: '1',
    check: (text) => /\b(1|one)\b/i.test(text),
  },
  {
    id: 'E05-cep-not-available',
    question: 'Descarga el CEP de 9c5d24ab-3333-4a33-8a33-000000000003.',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'downloadCep', arguments: { validation_id: '9c5d24ab-3333-4a33-8a33-000000000003' } }],
    expectedMethods: ['validations.cep'],
    expectsError: true,
    answer: 'No hay CEP: la operación falla con cep_unavailable.',
    check: contains('cep_unavailable'),
  },
  {
    id: 'E06-tracking-key',
    question: '¿Cuál es la clave de rastreo de 1a6b93f7-5555-4a55-8a55-000000000005?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '1a6b93f7-5555-4a55-8a55-000000000005' } }],
    expectedMethods: ['validations.get'],
    answer: 'MBAN01002608140000000005',
    check: contains('MBAN01002608140000000005'),
  },
  {
    id: 'E07-remaining-quota',
    question: '¿Cuántas validaciones me quedan este mes?',
    profile: 'usage',
    risk: 'read',
    steps: [{ operation: 'getUsageSummary', arguments: {} }],
    expectedMethods: ['usage.summary'],
    answer: '888',
    check: contains('888'),
  },
  {
    id: 'E08-bank-code',
    question: '¿Cuál es el código SPEI de BANORTE?',
    profile: 'catalog',
    risk: 'read',
    steps: [{ operation: 'listBanks', arguments: {} }],
    expectedMethods: ['catalog.banks'],
    answer: '40072',
    check: contains('40072'),
  },
  {
    id: 'E09-unknown-bin',
    question: '¿A qué banco pertenece el BIN 999999?',
    profile: 'catalog',
    risk: 'read',
    steps: [{ operation: 'lookupBin', arguments: { bin: '999999' } }],
    expectedMethods: ['catalog.binLookup'],
    expectsError: true,
    answer: 'A ninguno del catálogo: la búsqueda responde not_found.',
    check: contains('not_found'),
  },
  {
    id: 'E10-inactive-webhook',
    question: '¿Tengo algún webhook desactivado?',
    profile: 'webhooks',
    risk: 'read',
    steps: [{ operation: 'listWebhooks', arguments: {} }],
    expectedMethods: ['webhooks.list'],
    answer: 'Sí, wh_8f2c está inactivo.',
    check: contains('wh_8f2c'),
  },
  {
    id: 'W01-validate-a-transfer',
    question: 'Valida un pago de 1500.50 pesos con clave de rastreo MBAN0100260814 a la cuenta 012180004412345678.',
    profile: 'core',
    risk: 'write',
    steps: [
      { operation: 'validateAccount', arguments: { account: '012180004412345678' } },
      {
        operation: 'validateDirect',
        arguments: { amount: 1500.5, tracking_key: 'MBAN0100260814', beneficiary_account: '012180004412345678' },
      },
    ],
    expectedMethods: ['beneficiaries.validateAccount', 'validations.validate'],
    answer: `Válida, cuenta verificada contra el CEP, validación ${NEW_VALIDATION_ID}.`,
    check: (text) => text.includes(NEW_VALIDATION_ID) && /"status":"valid"/.test(text) && /idempotency_key/.test(text),
  },
  {
    id: 'W02-async-validation-and-wait',
    question: 'Pon en cola una validación y dime su veredicto final.',
    profile: 'core',
    risk: 'write',
    steps: [
      {
        operation: 'validateDirect',
        arguments: { amount: 99, tracking_key: 'ASYNC-1', beneficiary_account: '012180004412345678', async: true },
      },
      { operation: 'waitForValidation', arguments: { validation_id: QUEUED_VALIDATION_ID, timeout_seconds: 10 } },
    ],
    expectedMethods: ['validations.enqueue', 'validations.get'],
    answer: 'valid',
    check: (text) => /"terminal":true/.test(text) && /"status":"valid"/.test(text),
  },
  {
    id: 'W03-create-and-test-a-webhook',
    question: 'Registra https://example.test/hook para validation.completed y envía una prueba.',
    profile: 'webhooks',
    risk: 'write',
    steps: [
      { operation: 'createWebhook', arguments: { url: 'https://example.test/hook', events: ['validation.completed'] } },
      { operation: 'sendWebhookTest', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } },
    ],
    expectedMethods: ['webhooks.create', 'webhooks.test'],
    answer: 'El webhook se crea y la prueba se entrega con un 200.',
    check: contains('"response_status":200'),
  },
  {
    id: 'W04-export-ceps-and-wait',
    question: 'Exporta los CEP de septiembre de 2026 y avísame cuando el archivo esté listo.',
    profile: 'finance',
    risk: 'write',
    steps: [
      { operation: 'createFinanceCepExport', arguments: { from: '2026-09-01', to: '2026-09-30' } },
      { operation: 'waitForCepExport', arguments: { export_id: CEP_EXPORT_ID, timeout_seconds: 10 } },
      { operation: 'downloadFinanceCepExport', arguments: { export_id: CEP_EXPORT_ID } },
    ],
    expectedMethods: ['finance.createCepExport', 'finance.getCepExport', 'finance.downloadCepExport'],
    answer: 'La exportación está lista y el ZIP se descarga.',
    check: (text) => /ceps-2026-09\.zip/.test(text) && /"embedded":true/.test(text),
  },
  {
    id: 'W05-delete-a-webhook-after-confirming',
    question: 'Elimina el webhook aaaaaaaa-0000-4000-8000-0000000000aa.',
    profile: 'webhooks',
    risk: 'destructive',
    confirms: 'accept',
    steps: [{ operation: 'deleteWebhook', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } }],
    expectedMethods: ['webhooks.delete'],
    answer: 'El webhook se elimina cuando la persona confirma.',
    check: contains('"ok":true'),
  },
  {
    id: 'W06-keep-a-webhook-when-the-person-declines',
    question: 'Elimina el webhook aaaaaaaa-0000-4000-8000-0000000000aa.',
    profile: 'webhooks',
    risk: 'destructive',
    confirms: 'decline',
    steps: [{ operation: 'deleteWebhook', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } }],
    expectedMethods: [],
    forbiddenMethods: ['webhooks.delete'],
    answer: 'La operación no se ejecutó: la persona la rechazó.',
    check: (text) => /"executed":false/.test(text) && /"reason":"declined"/.test(text),
  },
  {
    id: 'X01-quota-spent',
    question: `Valida un pago con clave de rastreo ${QUOTA_TRACKING_KEY}.`,
    profile: 'core',
    risk: 'write',
    steps: [
      {
        operation: 'validateDirect',
        arguments: { amount: 10, tracking_key: QUOTA_TRACKING_KEY, beneficiary_account: '012180004412345678' },
      },
    ],
    expectedMethods: ['validations.validate'],
    expectsError: true,
    answer: 'La cuota se agotó: quota_exceeded, no se puede reintentar ahora, reintenta después de 864000 segundos.',
    check: (text) => /"code":"quota_exceeded"/.test(text) && /"kind":"quota"/.test(text) && /"retry_after_seconds":864000/.test(text),
  },
  {
    id: 'X02-invalid-candidate-list',
    question: `Valida un pago con clave de rastreo ${INVALID_TRACKING_KEY} y explica qué corregir.`,
    profile: 'core',
    risk: 'write',
    steps: [
      {
        operation: 'validateDirect',
        arguments: { amount: 10, tracking_key: INVALID_TRACKING_KEY, beneficiary_account: '012180004412345678' },
      },
    ],
    expectedMethods: ['validations.validate'],
    expectsError: true,
    answer: 'La lista candidate_accounts es demasiado larga: envía como máximo 3.',
    check: (text) => /\/candidate_accounts/.test(text) && /Envía como máximo 3/.test(text) && /"max":3/.test(text),
  },
] as const;
