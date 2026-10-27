/**
 * SDK falso alimentado por `datos.json`.
 *
 * Las evaluaciones no tocan la API real ni datos de clientes: el conjunto es
 * ficticio y vive versionado junto a los escenarios, de modo que una corrida
 * de hoy y una de dentro de seis meses parten de lo mismo.
 *
 * Además registra cada llamada. Una evaluación no sólo mira si la respuesta
 * final es correcta: mira si el modelo llegó por la herramienta que debía.
 */
import { readFileSync } from 'node:fs';

import { ConflictError, NotFoundError, type Veriko } from '@veriko-mx/sdk-runtime';

export interface Llamada {
  metodo: string;
  argumentos: readonly unknown[];
}

export interface Datos {
  validaciones: Array<Record<string, unknown>>;
  ceps: Record<string, { contenido: string; tipo: string }>;
  bancos: Array<Record<string, unknown>>;
  bines: Record<string, Record<string, unknown>>;
  banxico: Record<string, unknown>;
  consumo: { resumen: Record<string, unknown>; limites: Record<string, unknown> };
  planes: Array<Record<string, unknown>>;
  webhooks: Array<Record<string, unknown>>;
  beneficiarios: Array<Record<string, unknown>>;
  insights: { topBancos: Array<Record<string, unknown>> };
}

export function cargarDatos(): Datos {
  const ruta = new URL('./datos.json', import.meta.url);
  return JSON.parse(readFileSync(ruta, 'utf8')) as Datos;
}

export function crearApiFalsa(datos: Datos): { client: Veriko; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];

  const registrar =
    <T>(metodo: string, resultado: (...args: never[]) => T) =>
    (...argumentos: never[]): Promise<T> => {
      llamadas.push({ metodo, argumentos });
      return Promise.resolve(resultado(...argumentos));
    };

  const buscar = (id: unknown): Record<string, unknown> => {
    const encontrada = datos.validaciones.find((item) => item.id === id);
    if (!encontrada) {
      throw new NotFoundError('not_found', { status: 404, code: 'not_found' });
    }
    return encontrada;
  };

  const client = {
    validations: {
      list: registrar('validations.list', (args: { status?: string } | undefined) => {
        const status = args?.status;
        const data = status
          ? datos.validaciones.filter((item) => item.status === status)
          : datos.validaciones;
        return { data, meta: { total: data.length } };
      }),
      get: registrar('validations.get', (id: string) => ({ data: buscar(id) })),
      cep: registrar('validations.cep', (id: string) => {
        const cep = datos.ceps[id];
        if (!cep) throw new ConflictError('cep_unavailable', { status: 409, code: 'cep_unavailable' });
        return { data: cep };
      }),
    },
    catalog: {
      banks: registrar('catalog.banks', () => ({ data: datos.bancos })),
      binLookup: registrar('catalog.binLookup', (bin: string) => {
        const encontrado = datos.bines[bin];
        if (!encontrado) throw new NotFoundError('not_found', { status: 404, code: 'not_found' });
        return { data: encontrado };
      }),
      banxicoStatus: registrar('catalog.banxicoStatus', () => ({ data: datos.banxico })),
    },
    usage: {
      summary: registrar('usage.summary', () => ({ data: datos.consumo.resumen })),
      limits: registrar('usage.limits', () => ({ data: datos.consumo.limites })),
    },
    plans: {
      listPublic: registrar('plans.listPublic', () => ({ data: datos.planes })),
    },
    webhooks: {
      list: registrar('webhooks.list', () => ({ data: datos.webhooks })),
    },
    beneficiaries: {
      list: registrar('beneficiaries.list', () => ({ data: datos.beneficiarios })),
    },
    insights: {
      getTopBanks: registrar('insights.getTopBanks', () => ({ data: datos.insights.topBancos })),
    },
  } as unknown as Veriko;

  return { client, llamadas };
}
