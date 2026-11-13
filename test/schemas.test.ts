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

describe('limits of binary inputs and URLs', () => {
  it('accepts a 12 MB OCR image and rejects one more byte', () => {
    assert.equal(
      validateOcrSchema.safeParse({ image_base64: encodedBytes(12 * 1024 * 1024) }).success,
      true,
    );
    assert.equal(
      validateOcrSchema.safeParse({ image_base64: encodedBytes(12 * 1024 * 1024 + 1) }).success,
      false,
    );
  });

  it('accepts a 20 MB import and rejects one more byte', () => {
    assert.equal(
      createImportSchema.safeParse({ file_base64: encodedBytes(20 * 1024 * 1024), filename: 'a.csv' }).success,
      true,
    );
    assert.equal(
      createImportSchema.safeParse({ file_base64: encodedBytes(20 * 1024 * 1024 + 1), filename: 'a.csv' }).success,
      false,
    );
  });

  it('rejects truncated base64 even if Buffer could decode it', () => {
    assert.equal(validateOcrSchema.safeParse({ image_base64: 'YQ=' }).success, false);
    assert.equal(createImportSchema.safeParse({ file_base64: 'YQ===', filename: 'a.csv' }).success, false);
  });

  it('requires HTTPS for remote images and webhooks', () => {
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

  it('accepts a null description when creating a webhook', () => {
    assert.equal(
      createWebhookSchema.safeParse({
        url: 'https://example.com/hook',
        events: ['validation.completed'],
        description: null,
      }).success,
      true,
    );
  });

  it('accepts a 255-character description and rejects one more', () => {
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

describe('beneficiary account of the field validation', () => {
  const base = {
    send_date: '2026-09-19',
    amount: 100,
    tracking_key: 'ABC-123',
    beneficiary_account: '012180004412345678',
  };

  it('requires it unless candidate accounts are sent', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, true);

    const { beneficiary_account: _omitted, ...withoutAccount } = base;
    assert.equal(validateDirectSchema.safeParse(withoutAccount).success, false);
  });

  it('accepts CLABE, card and phone, and rejects any other length', () => {
    for (const account of ['012180004412345678', '4152313100001234', '5512345678']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, beneficiary_account: account }).success, true);
    }
    assert.equal(validateDirectSchema.safeParse({ ...base, beneficiary_account: '12345' }).success, false);
  });

  it('accepts up to 13 integer digits in the amount', () => {
    for (const amount of [9_999_999_999_999.99, '9999999999999.99']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, amount }).success, true);
    }
    for (const amount of [10_000_000_000_000, '10000000000000']) {
      assert.equal(validateDirectSchema.safeParse({ ...base, amount }).success, false);
    }
  });

  it('stays optional on the receipt', () => {
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png' }).success,
      true,
    );
  });
});

describe('own reference', () => {
  const base = {
    send_date: '2026-09-19',
    amount: 100,
    tracking_key: 'ABC-123',
    beneficiary_account: '012180004412345678',
  };

  it('accepts a client_ref of 1 to 64 characters in the validation and in the filters', () => {
    for (const length of [1, 64]) {
      const value = 'a'.repeat(length);
      assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: value }).success, true);
      assert.equal(validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: value }).success, true);
      assert.equal(listValidationsSchema.safeParse({ client_ref: value }).success, true);
      assert.equal(validationFiltersSchema.safeParse({ client_ref: value }).success, true);
      assert.equal(exportValidationsSchema.safeParse({ client_ref: value }).success, true);
    }
  });

  it('rejects an empty client_ref or one longer than 64 characters', () => {
    for (const value of ['', 'a'.repeat(65)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: value }).success, false);
      assert.equal(validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: value }).success, false);
      assert.equal(listValidationsSchema.safeParse({ client_ref: value }).success, false);
    }
  });

  it('rejects line breaks and control characters in the validation client_ref', () => {
    assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: 'orden\n4812' }).success, false);
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', client_ref: 'orden\t4812' }).success,
      false,
    );
    assert.equal(validateDirectSchema.safeParse({ ...base, client_ref: 'orden 4812' }).success, true);
  });
});

describe('accounts candidates', () => {
  const base = { send_date: '2026-09-19', amount: 100, tracking_key: 'ABC-123' };
  const candidates = ['012180004412345678', '002010077777777771'];

  it('acepta de 2 a 10 accounts en lugar de the account beneficiaria', () => {
    for (const count of [2, 3, 10]) {
      const list = Array.from({ length: count }, (_, index) => `00201007777777${String(7000 + index)}`);
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, true);
      assert.equal(
        validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', candidate_accounts: list }).success,
        true,
      );
    }
  });

  it('rejects a list of fewer than 2 or more than 10 accounts', () => {
    for (const list of [[], ['012180004412345678'], Array.from({ length: 11 }, (_, i) => `00201007777777${String(7000 + i)}`)]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, false);
      assert.equal(
        validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', candidate_accounts: list }).success,
        false,
      );
    }
  });

  it('rechaza accounts repetidas y accounts con otra longitud', () => {
    for (const list of [
      ['012180004412345678', '012180004412345678'],
      ['012180004412345678', '12345'],
    ]) {
      assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: list }).success, false);
    }
  });

  it('does not allow the account and the candidates together', () => {
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

  it('the field validation requires one of the two forms', () => {
    assert.equal(validateDirectSchema.safeParse(base).success, false);
    assert.equal(validateDirectSchema.safeParse({ ...base, candidate_accounts: candidates }).success, true);
  });
});

describe('keeping the receipt', () => {
  const base = { image_url: 'https://example.com/a.png' };

  it('accepts a boolean retain_image and rejects any other value', () => {
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: false }).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: true }).success, true);
    assert.equal(validateOcrSchema.safeParse(base).success, true);
    assert.equal(validateOcrSchema.safeParse({ ...base, retain_image: 'no' }).success, false);
  });
});

describe('optional send date', () => {
  it('accepts a validation without a date and still rejects a malformed date', () => {
    const base = { amount: 100, tracking_key: 'ABC-123', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse(base).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, send_date: '19/09/2026' }).success, false);
  });
});

describe('descriptions and semantics', () => {
  function fieldsOf(schema: z.ZodType): Record<string, { description?: string }> {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as {
      properties?: Record<string, { description?: string }>;
    };
    return json.properties ?? {};
  }

  it('every input field of every tool has a description', () => {
    const missing: string[] = [];
    for (const tool of TOOL_CATALOG) {
      for (const [name, property] of Object.entries(fieldsOf(tool.inputSchema))) {
        if (!property.description) missing.push(`${tool.name}.${name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('with_deleted and with_archived take 0 or 1 and say what each means', () => {
    assert.equal(listValidationsSchema.safeParse({ with_deleted: 1 }).success, true);
    assert.equal(listValidationsSchema.safeParse({ with_deleted: 0 }).success, true);
    assert.equal(listValidationsSchema.safeParse({ with_deleted: true }).success, false);
    assert.equal(listBeneficiariesSchema.safeParse({ with_archived: 1 }).success, true);
    assert.equal(listBeneficiariesSchema.safeParse({ with_archived: false }).success, false);
    assert.match(fieldsOf(listValidationsSchema).with_deleted?.description ?? '', /`1` returns only withdrawn/);
    assert.match(fieldsOf(listBeneficiariesSchema).with_archived?.description ?? '', /`1` returns only archived/);
  });

  it('recipient_is_bank is a boolean on both validation inputs', () => {
    const base = { amount: 100, tracking_key: 'ABC', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse({ ...base, recipient_is_bank: true }).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, recipient_is_bank: 1 }).success, false);
    assert.equal(
      validateOcrSchema.safeParse({ image_url: 'https://example.com/a.png', recipient_is_bank: true }).success,
      true,
    );
  });

  it('retry policy requires at least one retry and unique outcomes', () => {
    assert.equal(retryPolicySchema.safeParse({ max_retries: 0 }).success, false);
    assert.equal(retryPolicySchema.safeParse({ max_retries: 1 }).success, true);
    assert.equal(retryPolicySchema.safeParse({ outcomes: ['error', 'error'] }).success, false);
    assert.equal(retryPolicySchema.safeParse({ interval_seconds: 299 }).success, false);
  });

  it('a phone number needs bank_code and separators are accepted', () => {
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

  it('status, usage period and webhook events are closed sets', () => {
    assert.equal(listValidationsSchema.safeParse({ status: 'valdi' }).success, false);
    assert.equal(listValidationsSchema.safeParse({ status: ['valid', 'returned'] }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: 'current' }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: '2026-09' }).success, true);
    assert.equal(usageBreakdownSchema.safeParse({ period: 'last month' }).success, false);
    assert.equal(createWebhookSchema.safeParse({ url: 'https://example.com/h', events: ['nope'] }).success, false);
  });

  it('finance tools do not take the administrator-only user_id', () => {
    for (const schema of [financeSummarySchema, financePreviewSchema, financeCepsSchema]) {
      assert.equal('user_id' in fieldsOf(schema), false);
    }
    assert.equal(financeSummarySchema.safeParse({ month: '2026-09', user_id: 'x' }).success, false);
  });

  it('regenerate secret takes immediate', () => {
    assert.equal(
      regenerateWebhookSecretSchema.safeParse({
        webhook_id: '247af42e-1fd9-4d31-a330-a45d9d6ddbe5',
        immediate: true,
      }).success,
      true,
    );
  });

  it('the idempotency key follows the API pattern', () => {
    const base = { amount: 100, tracking_key: 'ABC', beneficiary_account: '012180004412345678' };
    assert.equal(validateDirectSchema.safeParse({ ...base, idempotency_key: 'order_4812-a' }).success, true);
    assert.equal(validateDirectSchema.safeParse({ ...base, idempotency_key: 'order 4812' }).success, false);
  });
});
