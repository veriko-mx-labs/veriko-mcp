/**
 * Scenarios for the catalog.
 *
 * Every scenario is independent and checkable, and carries the path it expects:
 *
 * - Independent: none depends on another having run before, so they can run in
 *   any order and in isolation.
 * - Fictitious: they run against `fake-api.ts`, never the real API, so a run
 *   against a real model costs no validations. The write scenarios (`W*`) and
 *   the error scenarios (`X*`) exercise the same code paths the read ones do.
 * - Checkable: `check` decides with a rule, not with a similarity judgment. A
 *   question that cannot be checked that way does not get in.
 * - With an expected path: the path is measured as well as the result. A right
 *   answer through the wrong tool is a fragile right answer.
 */
import {
  CEP_EXPORT_ID,
  INVALID_TRACKING_KEY,
  NEW_VALIDATION_ID,
  QUEUED_VALIDATION_ID,
  QUOTA_TRACKING_KEY,
} from './fake-api.js';

export interface Step {
  /** Operation of the catalog that answers this part of the question. */
  operation: string;
  /** Arguments of the reference path; a model deduces them on its own. */
  arguments: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  question: string;
  /** Smallest profile that makes the needed tools visible. */
  profile: string;
  /** Risk level the scenario needs. */
  risk: 'read' | 'write' | 'destructive';
  /**
   * The client declares the elicitation capability and answers the question the
   * server asks before a destructive tool with this action.
   */
  confirms?: 'accept' | 'decline';
  /** SDK calls the reference path must not make. */
  forbiddenMethods?: readonly string[];
  /** Tool calls of the reference path, in order. */
  steps: readonly Step[];
  /** SDK calls the reference path makes. */
  expectedMethods: readonly string[];
  /** Ground truth, derived from the fictitious data. */
  answer: string;
  /** The reference path ends in an error result the model has to read. */
  expectsError?: boolean;
  /** Rule that decides whether a free-text answer is correct. */
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
    question: 'What came of validation 2f4a7c91-1111-4a11-8a11-000000000001?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '2f4a7c91-1111-4a11-8a11-000000000001' } }],
    expectedMethods: ['validations.get'],
    answer: 'verified',
    check: contains('verified'),
  },
  {
    id: 'E02-returned-verdict',
    question: 'Did transfer 7b1e30d5-2222-4a22-8a22-000000000002 reach its destination?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '7b1e30d5-2222-4a22-8a22-000000000002' } }],
    expectedMethods: ['validations.get'],
    answer: 'No: its verdict is returned, the money went back to the sender.',
    check: contains('returned'),
  },
  {
    id: 'E03-tell-not-found-apart',
    question: 'Why did validation 9c5d24ab-3333-4a33-8a33-000000000003 fail?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '9c5d24ab-3333-4a33-8a33-000000000003' } }],
    expectedMethods: ['validations.get'],
    answer: 'Its verdict is not_found: Banxico found no CEP.',
    check: contains('not_found'),
  },
  {
    id: 'E04-count-by-status',
    question: 'How many validations do I have in the queued status?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'listValidations', arguments: { status: 'queued' } }],
    expectedMethods: ['validations.list'],
    answer: '1',
    check: (text) => /\b(1|one)\b/i.test(text),
  },
  {
    id: 'E05-cep-not-available',
    question: 'Download the CEP of 9c5d24ab-3333-4a33-8a33-000000000003.',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'downloadCep', arguments: { validation_id: '9c5d24ab-3333-4a33-8a33-000000000003' } }],
    expectedMethods: ['validations.cep'],
    expectsError: true,
    answer: 'There is no CEP: the operation fails with cep_unavailable.',
    check: contains('cep_unavailable'),
  },
  {
    id: 'E06-tracking-key',
    question: 'What is the tracking key of 1a6b93f7-5555-4a55-8a55-000000000005?',
    profile: 'core',
    risk: 'read',
    steps: [{ operation: 'getValidation', arguments: { validation_id: '1a6b93f7-5555-4a55-8a55-000000000005' } }],
    expectedMethods: ['validations.get'],
    answer: 'MBAN01002608140000000005',
    check: contains('MBAN01002608140000000005'),
  },
  {
    id: 'E07-remaining-quota',
    question: 'How many validations do I have left this month?',
    profile: 'usage',
    risk: 'read',
    steps: [{ operation: 'getUsageSummary', arguments: {} }],
    expectedMethods: ['usage.summary'],
    answer: '888',
    check: contains('888'),
  },
  {
    id: 'E08-bank-code',
    question: 'What is the SPEI code of BANORTE?',
    profile: 'catalog',
    risk: 'read',
    steps: [{ operation: 'listBanks', arguments: {} }],
    expectedMethods: ['catalog.banks'],
    answer: '40072',
    check: contains('40072'),
  },
  {
    id: 'E09-unknown-bin',
    question: 'Which bank does BIN 999999 belong to?',
    profile: 'catalog',
    risk: 'read',
    steps: [{ operation: 'lookupBin', arguments: { bin: '999999' } }],
    expectedMethods: ['catalog.binLookup'],
    expectsError: true,
    answer: 'None in the catalog: the lookup answers not_found.',
    check: contains('not_found'),
  },
  {
    id: 'E10-inactive-webhook',
    question: 'Do I have any webhook turned off?',
    profile: 'webhooks',
    risk: 'read',
    steps: [{ operation: 'listWebhooks', arguments: {} }],
    expectedMethods: ['webhooks.list'],
    answer: 'Yes, wh_8f2c is inactive.',
    check: contains('wh_8f2c'),
  },
  {
    id: 'W01-validate-a-transfer',
    question: 'Validate a payment of 1500.50 pesos with tracking key MBAN0100260814 to account 012180004412345678.',
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
    answer: `Valid, account cross-checked, validation ${NEW_VALIDATION_ID}.`,
    check: (text) => text.includes(NEW_VALIDATION_ID) && /"status":"valid"/.test(text) && /idempotency_key/.test(text),
  },
  {
    id: 'W02-async-validation-and-wait',
    question: 'Queue a validation and tell me its final verdict.',
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
    question: 'Register https://example.test/hook for validation.completed and send a test.',
    profile: 'webhooks',
    risk: 'write',
    steps: [
      { operation: 'createWebhook', arguments: { url: 'https://example.test/hook', events: ['validation.completed'] } },
      { operation: 'sendWebhookTest', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } },
    ],
    expectedMethods: ['webhooks.create', 'webhooks.test'],
    answer: 'The webhook is created and the test is delivered with a 200.',
    check: contains('"response_status":200'),
  },
  {
    id: 'W04-export-ceps-and-wait',
    question: 'Export the CEPs of September 2026 and tell me when the file is ready.',
    profile: 'finance',
    risk: 'write',
    steps: [
      { operation: 'createFinanceCepExport', arguments: { from: '2026-09-01', to: '2026-09-30' } },
      { operation: 'waitForCepExport', arguments: { export_id: CEP_EXPORT_ID, timeout_seconds: 10 } },
      { operation: 'downloadFinanceCepExport', arguments: { export_id: CEP_EXPORT_ID } },
    ],
    expectedMethods: ['finance.createCepExport', 'finance.getCepExport', 'finance.downloadCepExport'],
    answer: 'The export is ready and the ZIP is downloaded.',
    check: (text) => /ceps-2026-09\.zip/.test(text) && /"embedded":true/.test(text),
  },
  {
    id: 'W05-delete-a-webhook-after-confirming',
    question: 'Delete webhook aaaaaaaa-0000-4000-8000-0000000000aa.',
    profile: 'webhooks',
    risk: 'destructive',
    confirms: 'accept',
    steps: [{ operation: 'deleteWebhook', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } }],
    expectedMethods: ['webhooks.delete'],
    answer: 'The webhook is deleted once the person confirms.',
    check: contains('"ok":true'),
  },
  {
    id: 'W06-keep-a-webhook-when-the-person-declines',
    question: 'Delete webhook aaaaaaaa-0000-4000-8000-0000000000aa.',
    profile: 'webhooks',
    risk: 'destructive',
    confirms: 'decline',
    steps: [{ operation: 'deleteWebhook', arguments: { webhook_id: 'aaaaaaaa-0000-4000-8000-0000000000aa' } }],
    expectedMethods: [],
    forbiddenMethods: ['webhooks.delete'],
    answer: 'The operation did not run: the person declined.',
    check: (text) => /"executed":false/.test(text) && /"reason":"declined"/.test(text),
  },
  {
    id: 'X01-quota-spent',
    question: `Validate a payment with tracking key ${QUOTA_TRACKING_KEY}.`,
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
    answer: 'The quota is spent: quota_exceeded, not retryable now, retry after 864000 seconds.',
    check: (text) => /"code":"quota_exceeded"/.test(text) && /"kind":"quota"/.test(text) && /"retry_after_seconds":864000/.test(text),
  },
  {
    id: 'X02-invalid-candidate-list',
    question: `Validate a payment with tracking key ${INVALID_TRACKING_KEY} and explain what to fix.`,
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
    answer: 'The candidate_accounts list is too long: send at most 3.',
    check: (text) => /\/candidate_accounts/.test(text) && /Send at most 3/.test(text) && /"max":3/.test(text),
  },
] as const;
