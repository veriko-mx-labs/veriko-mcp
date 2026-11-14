import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { TOOL_CATALOG } from '../src/catalog.js';
import {
  createBeneficiarySchema,
  createImportSchema,
  createWebhookSchema,
  exportValidationsSchema,
  financeCepsSchema,
  financePreviewSchema,
  financeSummarySchema,
  listBeneficiariesSchema,
  listValidationsSchema,
  regenerateWebhookSecretSchema,
  retryPolicySchema,
  updateWebhookSchema,
  usageBreakdownSchema,
  validateDirectSchema,
  validateOcrSchema,
  validationFiltersSchema,
} from '../src/schemas.js';

function encodedBytes(size: number): string {
  return Buffer.alloc(size).toString('base64');
}

describe('límites de las entradas binarias y de las URL', () => {
  it('acepta una imagen OCR de 12 MB y rechaza un byte más', () => {
    assert.equal(
      validateOcrSchema.safeParse({ image_base64: encodedBytes(12 * 1024 * 1024) }).success,
      true,
    );
    assert.equal(
      validateOcrSchema.safeParse({ image_base64: encodedBytes(12 * 1024 * 1024 + 1) }).success,
      false,
    );
  });

  it('acepta una importación de 20 MB y rechaza un byte más', () => {
    assert.equal(
      createImportSchema.safeParse({ file_base64: encodedBytes(20 * 1024 * 1024), filename: 'a.csv' }).success,
      true,
    );
    assert.equal(
      createImportSchema.safeParse({ file_base64: encodedBytes(20 * 1024 * 1024 + 1), filename: 'a.csv' }).success,
      false,
    );
  });

  it('rechaza base64 truncado aunque Buffer pueda decodificarlo', () => {
    assert.equal(validateOcrSchema.safeParse({ image_base64: 'YQ=' }).success, false);
    assert.equal(createImportSchema.safeParse({ file_base64: 'YQ===', filename: 'a.csv' }).success, false);
  });

  it('exige HTTPS para imágenes y webhooks remotos', () => {
    assert.equal(validateOcrSchema.safeParse({ image_url: 'http://example.com/a.png' }).success, false);
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'http://example.com/hook',
        events: ['validation.completed'],
      }).success,
      false,
    );
    assert.equal(
      updateWebhookSchema.safeParse({
        webhook_id: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        url: 'https://example.com/hook',
      }).success,
      true,
    );
  });

  it('acepta una descripción null al crear un webhook', () => {
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: null,
      }).success,
      true,
    );
  });

  it('acepta una descripción de 255 caracteres y rechaza una más', () => {
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: 'a'.repeat(255),
      }).success,
      true,
    );
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: 'a'.repeat(256),
      }).success,
      false,
    );
    assert.equal(
      updateWebhookSchema.safeParse({
        webhook_id: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        description: 'a'.repeat(256),
      }).success,
      false,
    );
  });
});

describe('cuenta beneficiaria de la validación por campos', () => {
  const base = {
    send_date: '2026-09-19',
    amount: 100,
    tracking_key: 'ABC-123',
    beneficiary_account: '012180004412345678',
  };

  it('la exige, salvo que se envíen cuentas candidatas', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, true);

    const { beneficiary_account: _omitted, ...withoutAccount } = base;
    assert.equal(validateDirectSchema.safeParse(withoutAccount).success, false);
  });

  it('acepta CLABE, tarjeta y teléfono, y rechaza cualquier otra longitud', () => {
    for (const account of ['012180004412345678', '4152313100001234', '5512345678']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, beneficiary_account: account }).success, true);
    }
    assert.equal(validateDirectSchema.safeParse({ ...base, beneficiary_account: '12345' }).success, false);
  });

  it('acepta hasta 13 dígitos enteros en el monto', () => {
    for (const amount of [9_999_999_999_999.99, '9999999999999.99']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, amount }).success, true);
    }
    for (const amount of [10_000_000_000_000, '10000000000000']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, amount }).success, false);
    }
  });

  it('sigue siendo opcional en el comprobante', () => {
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png' }).success,
      true,
    );
  });
});

describe('referencia propia', () => {
  const base = {
    send_date: '2026-09-19',
    amount: 100,
    tracking_key: 'ABC-123',
    beneficiary_account: '012180004412345678',
  };

  it('acepta un client_ref de 1 a 64 caracteres en la validación y en los filtros', () => {
    for (const length of [1, 64]) {
      const value = 'a'.repeat(length);
      assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: value }).success, true);
      assert.equal(validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: value }).success, true);
      assert.equal(listValidationsSchema.safeParse({ client_ref: value }).success, true);
      assert.equal(validationFiltersSchema.safeParse({ client_ref: value }).success, true);
      assert.equal(exportValidationsSchema.safeParse({ client_ref: value }).success, true);
    }
  });

  it('rechaza un client_ref vacío o de más de 64 caracteres', () => {
    for (const value of ['', 'a'.repeat(65)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: value }).success, false);
      assert.equal(validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: value }).success, false);
      assert.equal(listValidationsSchema.safeParse({ client_ref: value }).success, false);
    }
  });

  it('rechaza saltos de línea y caracteres de control en el client_ref de la validación', () => {
    assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: 'orden\n4812' }).success, false);
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: 'orden\t4812' }).success,
      false,
    );
    assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: 'orden 4812' }).success, true);
  });
});

describe('cuentas candidatas', () => {
  const base = { send_date: '2026-09-19', amount: 100, tracking_key: 'ABC-123' };
  const candidates = ['012180004412345678', '002010077777777771'];

  it('acepta de 2 a 10 cuentas en lugar de la cuenta beneficiaria', () => {
    for (const count of [2, 3, 10]) {
      const list = Array.from({ length: count }, (_, index) => `00201007777777${String(7000 + index)}`);
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, true);
      assert.equal(
        validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', candidate_accounts: list }).success,
        true,
      );
    }
  });

  it('rechaza una lista de menos de 2 o de más de 10 cuentas', () => {
    for (const list of [[], ['012180004412345678'], Array.from({ length: 11 }, (_, i) => `00201007777777${String(7000 + i)}`)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, false);
      assert.equal(
        validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', candidate_accounts: list }).success,
        false,
      );
    }
  });

  it('rechaza cuentas repetidas y cuentas con otra longitud', () => {
    for (const list of [
      ['012180004412345678', '012180004412345678'],
      ['012180004412345678', '12345'],
    ]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, false);
    }
  });

  it('no permite la cuenta y las candidatas juntas', () => {
    assert.equal(
      validateDirectSchema.safeParse({
        ...base,
        beneficiary_account: '012180004412345678',
        candidate_accounts: candidates,
      }).success,
      false,
    );
    assert.equal(
      validateOcrSchema.safeParse({
        image_url: 'https://example.com/a.png',
        beneficiary_account: '012180004412345678',
        candidate_accounts: candidates,
      }).success,
      false,
    );
  });

  it('la validación por campos exige una de las dos formas', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, false);
    assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: candidates }).success, true);
  });
});

describe('conservar el comprobante', () => {
  const base = { image_url: 'https://example.com/a.png' };

  it('acepta un retain_image booleano y rechaza cualquier otro valor', () => {
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: false }).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: true }).success, true);
    assert.equal(validateOcrSchema.safeParse(base).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: 'no' }).success, false);
  });
});

describe('fecha de envío opcional', () => {
  it('acepta una validación sin fecha y sigue rechazando una fecha mal formada', () => {
    const base = { amount: 100, tracking_key: 'ABC-123', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse(base).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, send_date: '19/09/2026' }).success, false);
  });
});

describe('descripciones y semántica', () => {
  function fieldsOf(schema: z.ZodType): Record<string, { description?: string }> {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as {
      properties?: Record<string, { description?: string }>;
    };
    return json.properties ?? {};
  }

  it('cada campo de entrada de cada herramienta tiene descripción', () => {
    const missing: string[] = [];
    for (const tool of TOOL_CATALOG) {
      for (const [name, property] of Object.entries(fieldsOf(tool.inputSchema))) {
        if (!property.description) missing.push(`${tool.name}.${name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('with_deleted y with_archived toman 0 o 1 y dicen qué significa cada uno', () => {
    assert.equal(listValidationsSchema.safeParse({ with_deleted: 1 }).success, true);
    assert.equal(listValidationsSchema.safeParse({ with_deleted: 0 }).success, true);
    assert.equal(listValidationsSchema.safeParse({ with_deleted: true }).success, false);
    assert.equal(listBeneficiariesSchema.safeParse({ with_archived: 1 }).success, true);
    assert.equal(listBeneficiariesSchema.safeParse({ with_archived: false }).success, false);
    assert.match(fieldsOf(listValidationsSchema).with_deleted?.description ?? '', /`1` devuelve sólo las retiradas/);
    assert.match(fieldsOf(listBeneficiariesSchema).with_archived?.description ?? '', /`1` devuelve sólo las archivadas/);
  });

  it('recipient_is_bank es un booleano en las dos entradas de validación', () => {
    const base = { amount: 100, tracking_key: 'ABC', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse({ ...base, recipient_is_bank: true }).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, recipient_is_bank: 1 }).success, false);
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', recipient_is_bank: true }).success,
      true,
    );
  });

  it('la política de reintentos exige al menos un reintento y resultados únicos', () => {
    assert.equal(retryPolicySchema.safeParse({ max_retries: 0 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ max_retries: 1 }).success, true);
    assert.equal(retryPolicySchema.safeParse({ outcomes: ['error', 'error'] }).success, false);
    assert.equal(retryPolicySchema.safeParse({ interval_seconds: 299 }).success, false);
  });

  it('un teléfono necesita bank_code y se aceptan separadores', () => {
    assert.equal(createBeneficiarySchema.safeParse({ account_number: '5512345678' }).success, false);
    assert.equal(
      createBeneficiarySchema.safeParse({ account_number: '5512345678', bank_code: '40012' }).success,
      true,
    );
    assert.equal(
      createBeneficiarySchema.safeParse({ account_number: '0121 8000-4412345678' }).success,
      true,
    );
    assert.equal(createBeneficiarySchema.safeParse({ account_number: '12345' }).success, false);
  });

  it('status, el periodo de consumo y los eventos de webhook son conjuntos cerrados', () => {
    assert.equal(listValidationsSchema.safeParse({ status: 'valdi' }).success, false);
    assert.equal(listValidationsSchema.safeParse({ status: ['valid', 'returned'] }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: 'current' }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: '2026-09' }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: 'last month' }).success, false);
    assert.equal(createWebhookSchema.safeParse({ url: 'https://example.com/h', events: ['nope'] }).success, false);
  });

  it('las herramientas de finanzas no aceptan el user_id exclusivo de administradores', () => {
    for (const schema of [financeSummarySchema, financePreviewSchema, financeCepsSchema]) {
      assert.equal('user_id' in fieldsOf(schema), false);
    }
    assert.equal(financeSummarySchema.safeParse({ month: '2026-09', user_id: 'x' }).success, false);
  });

  it('regenerar el secreto acepta immediate', () => {
    assert.equal(
      regenerateWebhookSecretSchema.safeParse({
        webhook_id: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        immediate: true,
      }).success,
      true,
    );
  });

  it('la clave de idempotencia sigue el patrón de la API', () => {
    const base = { amount: 100, tracking_key: 'ABC', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse({ ...base, idempotency_key: 'order_4812-a' }).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, idempotency_key: 'order 4812' }).success, false);
  });
});
