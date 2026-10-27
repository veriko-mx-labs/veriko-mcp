import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createImportSchema,
  createWebhookSchema,
  exportValidationsSchema,
  listValidationsSchema,
  updateWebhookSchema,
  validateDirectSchema,
  validateOcrSchema,
  validationFiltersSchema,
} from '../src/schemas.js';

function encodedBytes(size: number): string {
  return Buffer.alloc(size).toString('base64');
}

describe('límites de entradas binarias y URLs', () => {
  it('acepta una imagen OCR de 12 MB y rechaza un byte adicional', () => {
    assert.equal(
      validateOcrSchema.safeParse({ imageBase64: encodedBytes(12 * 1024 * 1024) }).success,
      true,
    );
    assert.equal(
      validateOcrSchema.safeParse({ imageBase64: encodedBytes(12 * 1024 * 1024 + 1) }).success,
      false,
    );
  });

  it('acepta una importación de 20 MB y rechaza un byte adicional', () => {
    assert.equal(
      createImportSchema.safeParse({ fileBase64: encodedBytes(20 * 1024 * 1024) }).success,
      true,
    );
    assert.equal(
      createImportSchema.safeParse({ fileBase64: encodedBytes(20 * 1024 * 1024 + 1) }).success,
      false,
    );
  });

  it('rechaza base64 truncado aunque Buffer pudiera decodificarlo', () => {
    assert.equal(validateOcrSchema.safeParse({ imageBase64: 'YQ=' }).success, false);
    assert.equal(createImportSchema.safeParse({ fileBase64: 'YQ===' }).success, false);
  });

  it('exige HTTPS para imágenes remotas y webhooks', () => {
    assert.equal(validateOcrSchema.safeParse({ imageUrl: 'http://example.com/a.png' }).success, false);
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'http://example.com/hook',
        events: ['validation.completed'],
      }).success,
      false,
    );
    assert.equal(
      updateWebhookSchema.safeParse({
        webhookId: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        url: 'https://example.com/hook',
      }).success,
      true,
    );
  });

  it('acepta una descripción nula al crear un webhook', () => {
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: null,
      }).success,
      true,
    );
  });

  it('acepta una descripción de 255 caracteres y rechaza uno más', () => {
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
        webhookId: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        description: 'a'.repeat(256),
      }).success,
      false,
    );
  });
});

describe('cuenta beneficiaria de la validación por campos', () => {
  const base = {
    fecha: '2026-09-19',
    monto: 100,
    claveRastreo: 'ABC-123',
    cuentaBeneficiaria: '012180004412345678',
  };

  it('la exige, salvo que se envíen cuentas candidatas', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, true);

    const { cuentaBeneficiaria: _omitida, ...sinCuenta } = base;
    assert.equal(validateDirectSchema.safeParse(sinCuenta).success, false);
  });

  it('acepta CLABE, tarjeta y celular, y rechaza otra longitud', () => {
    for (const cuenta of ['012180004412345678', '4152313100001234', '5512345678']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, cuentaBeneficiaria: cuenta }).success, true);
    }
    assert.equal(validateDirectSchema.safeParse({ ...base, cuentaBeneficiaria: '12345' }).success, false);
  });

  it('en el comprobante sigue siendo opcional', () => {
    assert.equal(
      validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png' }).success,
      true,
    );
  });
});

describe('referencia propia', () => {
  const base = {
    fecha: '2026-09-19',
    monto: 100,
    claveRastreo: 'ABC-123',
    cuentaBeneficiaria: '012180004412345678',
  };

  it('acepta clientRef de 1 a 64 caracteres en la validación y en los filtros', () => {
    for (const largo of [1, 64]) {
      const valor = 'a'.repeat(largo);
      assert.equal(validateDirectSchema.safeParse({ ...base, clientRef: valor }).success, true);
      assert.equal(validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png', clientRef: valor }).success, true);
      assert.equal(listValidationsSchema.safeParse({ clientRef: valor }).success, true);
      assert.equal(validationFiltersSchema.safeParse({ clientRef: valor }).success, true);
      assert.equal(exportValidationsSchema.safeParse({ clientRef: valor }).success, true);
    }
  });

  it('rechaza un clientRef vacío o de más de 64 caracteres', () => {
    for (const valor of ['', 'a'.repeat(65)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, clientRef: valor }).success, false);
      assert.equal(validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png', clientRef: valor }).success, false);
      assert.equal(listValidationsSchema.safeParse({ clientRef: valor }).success, false);
    }
  });

  it('rechaza saltos de línea y caracteres de control en el clientRef de la validación', () => {
    assert.equal(validateDirectSchema.safeParse({ ...base, clientRef: 'orden\n4812' }).success, false);
    assert.equal(
      validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png', clientRef: 'orden\t4812' }).success,
      false,
    );
    assert.equal(validateDirectSchema.safeParse({ ...base, clientRef: 'orden 4812' }).success, true);
  });
});

describe('cuentas candidatas', () => {
  const base = { fecha: '2026-09-19', monto: 100, claveRastreo: 'ABC-123' };
  const candidatas = ['012180004412345678', '002010077777777771'];

  it('acepta de 2 a 10 cuentas en lugar de la cuenta beneficiaria', () => {
    for (const cantidad of [2, 3, 10]) {
      const lista = Array.from({ length: cantidad }, (_, index) => `00201007777777${String(7000 + index)}`);
      assert.equal(validateDirectSchema.safeParse({ ...base, cuentasCandidatas: lista }).success, true);
      assert.equal(
        validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png', cuentasCandidatas: lista }).success,
        true,
      );
    }
  });

  it('rechaza una lista de menos de 2 o de más de 10 cuentas', () => {
    for (const lista of [[], ['012180004412345678'], Array.from({ length: 11 }, (_, i) => `00201007777777${String(7000 + i)}`)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, cuentasCandidatas: lista }).success, false);
      assert.equal(
        validateOcrSchema.safeParse({ imageUrl: 'https://example.com/a.png', cuentasCandidatas: lista }).success,
        false,
      );
    }
  });

  it('rechaza cuentas repetidas y cuentas con otra longitud', () => {
    for (const lista of [
      ['012180004412345678', '012180004412345678'],
      ['012180004412345678', '12345'],
    ]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, cuentasCandidatas: lista }).success, false);
    }
  });

  it('no admite la cuenta y las candidatas juntas', () => {
    assert.equal(
      validateDirectSchema.safeParse({
        ...base,
        cuentaBeneficiaria: '012180004412345678',
        cuentasCandidatas: candidatas,
      }).success,
      false,
    );
    assert.equal(
      validateOcrSchema.safeParse({
        imageUrl: 'https://example.com/a.png',
        cuentaBeneficiaria: '012180004412345678',
        cuentasCandidatas: candidatas,
      }).success,
      false,
    );
  });

  it('la validación por campos exige una de las dos formas', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, false);
    assert.equal(validateDirectSchema.safeParse({ ...base, cuentasCandidatas: candidatas }).success, true);
  });
});

describe('conservar el comprobante', () => {
  const base = { imageUrl: 'https://example.com/a.png' };

  it('acepta retainImage booleano y rechaza cualquier otro valor', () => {
    assert.equal(validateOcrSchema.safeParse({ ...base, retainImage: false }).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retainImage: true }).success, true);
    assert.equal(validateOcrSchema.safeParse(base).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retainImage: 'no' }).success, false);
  });
});
