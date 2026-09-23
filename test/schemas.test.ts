import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createImportSchema,
  createWebhookSchema,
  updateWebhookSchema,
  validateOcrSchema,
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
});
