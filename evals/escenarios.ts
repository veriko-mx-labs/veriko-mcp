/**
 * Diez escenarios de sólo lectura.
 *
 * Reglas que cumplen todos, y que son lo que los hace medibles:
 *
 * - Independientes: ninguno depende de que otro haya corrido antes, así que
 *   pueden ejecutarse en cualquier orden y aislados.
 * - Sólo lectura: ninguno consume cuota ni modifica nada, de modo que una
 *   corrida contra un modelo real no cuesta validaciones.
 * - Respuesta verificable: `comprobar` decide con una regla, no con un juicio
 *   de parecido. Si una pregunta no se puede comprobar así, no entra.
 * - Con herramienta esperada: se mide también el camino, no sólo el resultado.
 *   Un acierto por la herramienta equivocada es un acierto frágil.
 */
export interface Escenario {
  id: string;
  pregunta: string;
  /** Perfil mínimo que hace visible la herramienta necesaria. */
  perfil: string;
  /** Operación del catálogo que resuelve la pregunta por el camino correcto. */
  operacion: string;
  /** Llamadas del SDK que resuelven la pregunta por el camino correcto. */
  metodosEsperados: readonly string[];
  /** Verdad de referencia, derivada del conjunto sanitizado. */
  respuesta: string;
  /** Regla que decide si una respuesta en texto libre es correcta. */
  comprobar(texto: string): boolean;
}

const contiene =
  (...fragmentos: readonly string[]) =>
  (texto: string): boolean => {
    const plano = texto.toLowerCase();
    return fragmentos.every((fragmento) => plano.includes(fragmento.toLowerCase()));
  };

export const ESCENARIOS: readonly Escenario[] = [
  {
    id: 'E01-estado-de-una-validacion',
    operacion: 'getValidation',
    pregunta: '¿En qué quedó la validación 2f4a7c91-1111-4a11-8a11-000000000001?',
    perfil: 'core',
    metodosEsperados: ['validations.get'],
    respuesta: 'verified',
    comprobar: contiene('verified'),
  },
  {
    id: 'E02-veredicto-devuelto',
    operacion: 'getValidation',
    pregunta: '¿La transferencia 7b1e30d5-2222-4a22-8a22-000000000002 llegó a su destino?',
    perfil: 'core',
    metodosEsperados: ['validations.get'],
    respuesta: 'No: su veredicto es returned, el dinero se devolvió al emisor.',
    comprobar: contiene('returned'),
  },
  {
    id: 'E03-distinguir-not-found',
    operacion: 'getValidation',
    pregunta: '¿Por qué falló la validación 9c5d24ab-3333-4a33-8a33-000000000003?',
    perfil: 'core',
    metodosEsperados: ['validations.get'],
    respuesta: 'Su veredicto es not_found: Banxico no encontró el CEP.',
    comprobar: contiene('not_found'),
  },
  {
    id: 'E04-contar-por-estado',
    operacion: 'listValidations',
    pregunta: '¿Cuántas validaciones tengo en estado pending?',
    perfil: 'core',
    metodosEsperados: ['validations.list'],
    respuesta: '1',
    comprobar: (texto) => /\b(1|una|uno)\b/i.test(texto),
  },
  {
    id: 'E05-cep-no-disponible',
    operacion: 'downloadCep',
    pregunta: 'Descarga el CEP de 9c5d24ab-3333-4a33-8a33-000000000003.',
    perfil: 'core',
    metodosEsperados: ['validations.cep'],
    respuesta: 'No hay CEP: la operación falla con cep_unavailable.',
    comprobar: contiene('cep_unavailable'),
  },
  {
    id: 'E06-clave-de-rastreo',
    operacion: 'getValidation',
    pregunta: '¿Cuál es la clave de rastreo de 1a6b93f7-5555-4a55-8a55-000000000005?',
    perfil: 'core',
    metodosEsperados: ['validations.get'],
    respuesta: 'MBAN01002608140000000005',
    comprobar: contiene('MBAN01002608140000000005'),
  },
  {
    id: 'E07-cuota-restante',
    operacion: 'getUsageSummary',
    pregunta: '¿Cuántas validaciones me quedan este mes?',
    perfil: 'usage',
    metodosEsperados: ['usage.summary'],
    respuesta: '888',
    comprobar: contiene('888'),
  },
  {
    id: 'E08-clave-de-banco',
    operacion: 'listBanks',
    pregunta: '¿Cuál es la clave SPEI de BANORTE?',
    perfil: 'catalog',
    metodosEsperados: ['catalog.banks'],
    respuesta: '40072',
    comprobar: contiene('40072'),
  },
  {
    id: 'E09-bin-desconocido',
    operacion: 'lookupBin',
    pregunta: '¿A qué banco pertenece el BIN 999999?',
    perfil: 'catalog',
    metodosEsperados: ['catalog.binLookup'],
    respuesta: 'A ninguno del catálogo: la consulta responde not_found.',
    comprobar: contiene('not_found'),
  },
  {
    id: 'E10-webhook-inactivo',
    operacion: 'listWebhooks',
    pregunta: '¿Tengo algún webhook apagado?',
    perfil: 'webhooks',
    metodosEsperados: ['webhooks.list'],
    respuesta: 'Sí, wh_8f2c está inactivo.',
    comprobar: contiene('wh_8f2c'),
  },
] as const;
