import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Veriko } from '@veriko-mx/sdk-runtime';

import { TOOL_CATALOG } from '../src/catalog.js';

interface Seen {
  method: string;
  url: string;
  body: string;
}

const seen: Seen[] = [];
let server: Server;
let client: Veriko;

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [], meta: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  client = new Veriko({
    apiKey: 'veriko_prueba',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    maxRetries: 0,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

async function invoke(operationId: string, args: Record<string, unknown>): Promise<Seen> {
  const tool = TOOL_CATALOG.find((candidate) => candidate.operationId === operationId);
  assert.ok(tool, operationId);
  await tool.invoke(client, args).catch(() => undefined);
  const request = seen[0];
  assert.ok(request, `${operationId} no llegó a la API`);
  return request;
}

describe('lo que el SDK envía a la API', () => {
  it('clientRef viaja como client_ref en las dos validaciones', async () => {
    const campos = {
      fecha: '2026-09-19',
      monto: 100,
      claveRastreo: 'ABC-123',
      cuentaBeneficiaria: '012180004412345678',
      clientRef: 'orden-4812',
    };

    const directa = await invoke('validateDirect', campos);
    assert.equal(directa.url, '/v1/validate');
    assert.equal((JSON.parse(directa.body) as Record<string, unknown>)['client_ref'], 'orden-4812');

    seen.length = 0;
    const cola = await invoke('validateDirect', { ...campos, async: true });
    assert.equal(cola.url, '/v1/validate?async=1');
    assert.equal((JSON.parse(cola.body) as Record<string, unknown>)['client_ref'], 'orden-4812');

    seen.length = 0;
    const ocr = await invoke('validateOcr', {
      imageUrl: 'https://example.com/a.png',
      clientRef: 'orden-4812',
    });
    assert.equal(ocr.url, '/v1/validate-ocr');
    assert.equal((JSON.parse(ocr.body) as Record<string, unknown>)['client_ref'], 'orden-4812');
  });

  it('clientRef viaja como client_ref en el listado, las estadísticas y la exportación', async () => {
    for (const [operationId, path] of [
      ['listValidations', '/v1/validations'],
      ['validationStats', '/v1/validations/stats'],
      ['exportValidations', '/v1/validations/export'],
    ] as const) {
      seen.length = 0;
      const request = await invoke(operationId, { clientRef: 'orden 4812' });
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.pathname, path);
      assert.equal(url.searchParams.get('client_ref'), 'orden 4812', operationId);
    }
  });

  it('sin clientRef no viaja ninguna referencia', async () => {
    const request = await invoke('listValidations', {});

    assert.equal(request.url.includes('client_ref'), false);
  });
});

describe('lo que el SDK envía a la API: cuentas, comprobante y revisión', () => {
  it('cuentasCandidatas viaja como cuentas_candidatas, sin cuenta_beneficiaria', async () => {
    const cuentas = ['012180004412345678', '002010077777777771'];

    const directa = await invoke('validateDirect', {
      fecha: '2026-09-19',
      monto: 100,
      claveRastreo: 'ABC-123',
      cuentasCandidatas: cuentas,
    });
    const body = JSON.parse(directa.body) as Record<string, unknown>;
    assert.equal(directa.url, '/v1/validate');
    assert.deepEqual(body['cuentas_candidatas'], cuentas);
    assert.equal('cuenta_beneficiaria' in body, false);

    seen.length = 0;
    const ocr = await invoke('validateOcr', {
      imageUrl: 'https://example.com/a.png',
      cuentasCandidatas: cuentas,
      async: true,
    });
    assert.equal(ocr.url, '/v1/validate-ocr?async=1');
    assert.deepEqual((JSON.parse(ocr.body) as Record<string, unknown>)['cuentas_candidatas'], cuentas);
  });

  it('retainImage viaja como retain_image, también en false', async () => {
    const sin = await invoke('validateOcr', { imageUrl: 'https://example.com/a.png' });
    assert.equal('retain_image' in (JSON.parse(sin.body) as Record<string, unknown>), false);

    seen.length = 0;
    const con = await invoke('validateOcr', {
      imageUrl: 'https://example.com/a.png',
      retainImage: false,
    });
    assert.equal((JSON.parse(con.body) as Record<string, unknown>)['retain_image'], false);
  });

  it('revisar el pago hace un POST a /recheck sin cuerpo', async () => {
    const request = await invoke('recheckValidation', {
      validationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });

    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/validations/f47ac10b-58cc-4372-a567-0e02b2c3d479/recheck');
    assert.equal(request.body, '');
  });
});
