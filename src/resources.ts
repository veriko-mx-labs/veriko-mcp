import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { ApiError, type Veriko } from '@veriko-mx/sdk-runtime';

import { bankCompleter, completeYear } from './completions.js';

const JSON_TYPE = 'application/json';
const DOCS = 'https://docs.veriko.mx/es';

/** Páginas de la documentación pública a las que el modelo puede remitir a una persona. */
export const DOC_LINKS: ReadonlyArray<{ title: string; url: string; about: string }> = [
  { title: 'Flujo de validación', url: `${DOCS}/concepts/validation-flow`, about: 'Los veredictos y qué significa cada uno.' },
  { title: 'Validaciones asíncronas', url: `${DOCS}/concepts/async-validations`, about: 'El parámetro async, la respuesta 202 y la consulta periódica.' },
  { title: 'Idempotencia', url: `${DOCS}/concepts/idempotency`, about: 'El encabezado Idempotency-Key y su ventana de 24 horas.' },
  { title: 'Errores', url: `${DOCS}/concepts/errors`, about: 'El arreglo errors, los códigos, las pistas y los punteros de campo.' },
  { title: 'Taxonomía de errores', url: `${DOCS}/concepts/errors-taxonomy`, about: 'Todos los códigos de error.' },
  { title: 'Cuotas y planes', url: `${DOCS}/concepts/quotas-and-plans`, about: 'Cuota mensual, encabezados de cuota y quota_exceeded.' },
  { title: 'Límites de frecuencia', url: `${DOCS}/concepts/rate-limits`, about: 'Peticiones por minuto y Retry-After.' },
  { title: 'Política de reintentos', url: `${DOCS}/concepts/retry-policy`, about: 'Reintentos automáticos de validaciones.' },
  { title: 'Arquitectura de webhooks', url: `${DOCS}/concepts/webhooks-architecture`, about: 'Eventos, firmas y entregas.' },
  { title: 'Beneficiarios', url: `${DOCS}/concepts/beneficiaries`, about: 'Cuentas guardadas e importaciones masivas.' },
  { title: 'Exportaciones y formatos', url: `${DOCS}/concepts/exports-and-formats`, about: 'Exportaciones CSV y XLSX.' },
  { title: 'Servidor MCP de Veriko', url: `${DOCS}/mcp`, about: 'Instala y configura este servidor.' },
];

function docsMarkdown(): string {
  return [
    '# Documentación de Veriko',
    '',
    ...DOC_LINKS.map((link) => `- [${link.title}](${link.url}): ${link.about}`),
    '',
  ].join('\n');
}

async function readJson(uri: URL, load: () => Promise<unknown>) {
  try {
    const value = await load();
    return { contents: [{ uri: uri.href, mimeType: JSON_TYPE, text: JSON.stringify(value) }] };
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(
        `Veriko respondió ${error.status}${error.code ? ` ${error.code}` : ''} al leer ${uri.href}.`,
      );
    }
    throw error;
  }
}

/** Datos de referencia de sólo lectura que no necesitan llamar a una herramienta. */
export function registerReferenceResources(server: McpServer, client: Veriko): void {
  const bankCode = bankCompleter(client);
  server.registerResource(
    'banks',
    'veriko://catalog/banks',
    {
      title: 'Bancos SPEI',
      description: 'Catálogo de participantes SPEI con sus códigos. Datos públicos.',
      mimeType: JSON_TYPE,
    },
    (uri) => readJson(uri, () => client.catalog.banks()),
  );
  server.registerResource(
    'bank',
    new ResourceTemplate('veriko://catalog/banks/{code}', {
      list: undefined,
      complete: { code: bankCode },
    }),
    {
      title: 'Banco SPEI',
      description: 'Un participante del catálogo SPEI por su código de 5 dígitos. Datos públicos.',
      mimeType: JSON_TYPE,
    },
    (uri, variables) => {
      const code = String(variables.code);
      if (!/^\d{5}$/.test(code)) {
        throw new Error('El código de banco tiene 5 dígitos, por ejemplo veriko://catalog/banks/40012.');
      }
      return readJson(uri, async () => {
        const banks = (await client.catalog.banks()) as unknown as Array<{ id?: string; attributes?: { code?: string } }>;
        const bank = banks.find((entry) => entry.attributes?.code === code || entry.id === code);
        if (!bank) throw new Error(`El catálogo SPEI no tiene el banco ${code}.`);
        return bank;
      });
    },
  );
  server.registerResource(
    'spei_calendar',
    new ResourceTemplate('veriko://catalog/spei-calendar/{year}', {
      list: undefined,
      complete: { year: (typed) => completeYear(typed) },
    }),
    {
      title: 'Calendario SPEI',
      description: 'Días inhábiles SPEI de un año de cuatro dígitos, con la disposición oficial de la que salen.',
      mimeType: JSON_TYPE,
    },
    (uri, variables) => {
      const year = Number(variables.year);
      if (!Number.isInteger(year) || year < 1000 || year > 9999) {
        throw new Error('El año debe tener cuatro dígitos, por ejemplo veriko://catalog/spei-calendar/2026.');
      }
      return readJson(uri, () => client.catalog.speiCalendar(year));
    },
  );
  server.registerResource(
    'plans',
    'veriko://plans',
    {
      title: 'Planes públicos',
      description: 'Los planes públicos de Veriko y sus precios. Datos públicos.',
      mimeType: JSON_TYPE,
    },
    (uri) => readJson(uri, () => client.plans.listPublic()),
  );
  server.registerResource(
    'banxico_status',
    'veriko://status/banxico',
    {
      title: 'Estado de Banxico',
      description: 'Estado público del servicio CEP de Banxico. Requiere clave de API.',
      mimeType: JSON_TYPE,
    },
    (uri) => readJson(uri, () => client.catalog.banxicoStatus()),
  );
  server.registerResource(
    'documentation',
    'veriko://docs',
    {
      title: 'Enlaces a la documentación',
      description: 'Enlaces a la documentación pública de Veriko sobre validación, errores, idempotencia y cuotas.',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: docsMarkdown() }] }),
  );
}
