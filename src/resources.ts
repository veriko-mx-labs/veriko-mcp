import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { ApiError, type Veriko } from '@veriko-mx/sdk-runtime';

import { bankCompleter, completeYear } from './completions.js';

const JSON_TYPE = 'application/json';
const DOCS = 'https://docs.veriko.mx/en';

/** Pages of the public documentation the model can point a person to. */
export const DOC_LINKS: ReadonlyArray<{ title: string; url: string; about: string }> = [
  { title: 'Validation flow', url: `${DOCS}/concepts/validation-flow`, about: 'Verdicts and what each one means.' },
  { title: 'Asynchronous validations', url: `${DOCS}/concepts/async-validations`, about: 'The async parameter, the 202 response and polling.' },
  { title: 'Idempotency', url: `${DOCS}/concepts/idempotency`, about: 'The Idempotency-Key header and its 24-hour window.' },
  { title: 'Errors', url: `${DOCS}/concepts/errors`, about: 'The errors array, codes, hints and field pointers.' },
  { title: 'Errors taxonomy', url: `${DOCS}/concepts/errors-taxonomy`, about: 'Every error code.' },
  { title: 'Quotas and plans', url: `${DOCS}/concepts/quotas-and-plans`, about: 'Monthly quota, quota headers and quota_exceeded.' },
  { title: 'Rate limits', url: `${DOCS}/concepts/rate-limits`, about: 'Requests per minute and Retry-After.' },
  { title: 'Retry policy', url: `${DOCS}/concepts/retry-policy`, about: 'Automatic retries of validations.' },
  { title: 'Webhooks architecture', url: `${DOCS}/concepts/webhooks-architecture`, about: 'Events, signatures and deliveries.' },
  { title: 'Beneficiaries', url: `${DOCS}/concepts/beneficiaries`, about: 'Saved accounts and bulk imports.' },
  { title: 'Exports and formats', url: `${DOCS}/concepts/exports-and-formats`, about: 'CSV and XLSX exports.' },
  { title: 'Veriko MCP server', url: `${DOCS}/mcp`, about: 'Install and configure this server.' },
];

function docsMarkdown(): string {
  return [
    '# Veriko documentation',
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
        `Veriko answered ${error.status}${error.code ? ` ${error.code}` : ''} while reading ${uri.href}.`,
      );
    }
    throw error;
  }
}

/** Read-only reference data that needs no tool call. */
export function registerReferenceResources(server: McpServer, client: Veriko): void {
  const bankCode = bankCompleter(client);
  server.registerResource(
    'banks',
    'veriko://catalog/banks',
    {
      title: 'SPEI banks',
      description: 'Catalog of SPEI participants with their codes. Public data.',
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
      title: 'SPEI bank',
      description: 'One participant of the SPEI catalog by its 5-digit code. Public data.',
      mimeType: JSON_TYPE,
    },
    (uri, variables) => {
      const code = String(variables.code);
      if (!/^\d{5}$/.test(code)) {
        throw new Error('The bank code has 5 digits, for example veriko://catalog/banks/40012.');
      }
      return readJson(uri, async () => {
        const banks = (await client.catalog.banks()) as unknown as Array<{ id?: string; attributes?: { code?: string } }>;
        const bank = banks.find((entry) => entry.attributes?.code === code || entry.id === code);
        if (!bank) throw new Error(`The SPEI catalog has no bank ${code}.`);
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
      title: 'SPEI calendar',
      description: 'Non-business SPEI days of a four-digit year, with the official provision they come from.',
      mimeType: JSON_TYPE,
    },
    (uri, variables) => {
      const year = Number(variables.year);
      if (!Number.isInteger(year) || year < 1000 || year > 9999) {
        throw new Error('The year must be four digits, for example veriko://catalog/spei-calendar/2026.');
      }
      return readJson(uri, () => client.catalog.speiCalendar(year));
    },
  );
  server.registerResource(
    'plans',
    'veriko://plans',
    {
      title: 'Public plans',
      description: 'The public plans of Veriko and their prices. Public data.',
      mimeType: JSON_TYPE,
    },
    (uri) => readJson(uri, () => client.plans.listPublic()),
  );
  server.registerResource(
    'banxico_status',
    'veriko://status/banxico',
    {
      title: 'Banxico status',
      description: 'Public status of the Banxico CEP service. Needs an API key.',
      mimeType: JSON_TYPE,
    },
    (uri) => readJson(uri, () => client.catalog.banxicoStatus()),
  );
  server.registerResource(
    'documentation',
    'veriko://docs',
    {
      title: 'Documentation links',
      description: 'Links to the public Veriko documentation on validation, errors, idempotency and quotas.',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: docsMarkdown() }] }),
  );
}
