import { completable, type McpServer } from '@modelcontextprotocol/server';
import type { Veriko } from '@veriko-mx/sdk-runtime';
import { z } from 'zod';

import { bankCompleter, completeEvent, completeFormat, completeStatus } from './completions.js';

function user(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Reusable flows. Each names the tools it needs; some need a wider `VERIKO_MCP_PROFILE`. */
export function registerPrompts(server: McpServer, client: Veriko): void {
  const bankCode = bankCompleter(client);
  server.registerPrompt(
    'check_transfer',
    {
      title: 'Check a transfer and explain the verdict',
      description: 'Validates one SPEI transfer and explains the verdict, its caveats and the next step.',
      argsSchema: z.object({
        details: z
          .string()
          .describe('What is known: amount, tracking key or numeric reference, beneficiary account, send date, or a receipt URL.'),
        beneficiary_bank: completable(z.string().regex(/^\d{4,5}$/).describe('SPEI code of the beneficiary bank, when known.'), bankCode).optional(),
      }),
    },
    ({ details, beneficiary_bank }) =>
      user(
        [
          `Check this SPEI transfer: ${details}${beneficiary_bank ? ` (beneficiary bank ${beneficiary_bank})` : ''}`,
          '',
          '1. If an account number is given, call veriko_validate_account first and fix it if `checksum_valid` is false.',
          '2. Call veriko_get_usage_limits and stop to ask if the remaining quota is low: each validation consumes quota.',
          '3. Call veriko_validate_direct (or veriko_validate_ocr for a receipt). Do not repeat the call with the same arguments unless you reuse its `idempotency_key`.',
          '4. If the status is `queued` or `processing`, call veriko_wait_for_validation until `terminal` is true.',
          '5. Explain the verdict. A `not_found` can mean Banxico has not published the CEP yet; offer a retry policy. If `account_cross_checked` is false, say that `valid` confirms the transfer exists but not that it was paid to the expected account.',
          '6. Offer veriko_download_cep, and veriko_recheck_validation within 72 hours to detect a return.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'reconcile_month',
    {
      title: 'Reconcile a month',
      description: 'Summarizes the validations and finances of a month and flags what needs attention.',
      argsSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe('Month as YYYY-MM.') }),
    },
    ({ month }) =>
      user(
        [
          `Reconcile ${month}. This needs the finance and validations profiles.`,
          '1. veriko_get_finance_summary for the month.',
          '2. veriko_validation_stats with `from` and `to` set to the month, then veriko_list_validations for `returned`, `failed` and `error` rows.',
          '3. veriko_get_finance_by_bank and veriko_get_finance_counterparties previews for the largest differences.',
          '4. Report totals, the returned payments, and the rows to review. Offer a CSV with veriko_get_finance_accounting.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'triage_failed_validations',
    {
      title: 'Triage failed validations',
      description: 'Finds validations that did not end in a verdict and proposes a fix for each group.',
      argsSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date, YYYY-MM-DD.'),
        status: completable(z.string().describe('Look at one status first, for example `not_found`.'), completeStatus).optional(),
      }),
    },
    ({ from, status }) =>
      user(
        [
          `Triage the validations that failed${from ? ` since ${from}` : ' recently'}. This needs the validations profile.`,
          status
            ? `1. veriko_list_validations with status \`${status}\` first, then the other failed statuses (\`failed\`, \`error\`, \`cep_unavailable\`, \`not_found\`).`
            : '1. veriko_list_validations with status `failed`, `error` and `cep_unavailable`, then `not_found`.',
          '2. Group by `error_code`. For `cep_unavailable`, check veriko_banxico_public_status.',
          '3. For `not_found`, read veriko_list_validation_retry_attempts and propose veriko_update_validation_retry_policy when no retry is running.',
          '4. Summarize each group, and ask before changing any policy.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'set_up_webhook',
    {
      title: 'Set up and test a webhook',
      description: 'Registers a webhook endpoint, tests it and checks the delivery.',
      argsSchema: z.object({
        url: z.string().url().describe('HTTPS URL that receives the events.'),
        event: completable(z.string().describe('An event to subscribe to, for example `validation.completed`.'), completeEvent).optional(),
      }),
    },
    ({ url, event }) =>
      user(
        [
          `Set up a webhook for ${url}. This needs the webhooks profile.`,
          `1. veriko_create_webhook with ${event ? `the event \`${event}\` and any other` : 'the'} events the user needs. The signing secret appears once: tell the user to store it, and do not repeat it.`,
          '2. veriko_send_webhook_test, then veriko_list_webhook_deliveries to read the receiver response.',
          '3. If the secret was exposed, veriko_regenerate_webhook_secret with `immediate: true`.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'export_validations',
    {
      title: 'Export validations',
      description: 'Exports the validations of a period, filtered by status or bank, as a CSV or XLSX file.',
      argsSchema: z.object({
        format: completable(z.string().describe('`csv` (default) or `xlsx`.'), completeFormat).optional(),
        status: completable(z.string().describe('Only this status, for example `returned`.'), completeStatus).optional(),
        bank: completable(z.string().describe('Only this SPEI bank code.'), bankCode).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date, YYYY-MM-DD.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date, YYYY-MM-DD.'),
      }),
    },
    ({ format, status, bank, from, to }) =>
      user(
        [
          `Export validations as ${format ?? 'csv'}.`,
          '1. Call veriko_validation_stats with the same filters to see how many rows the file will have.',
          `2. Call veriko_export_validations with ${[
            `format \`${format ?? 'csv'}\``,
            status ? `status \`${status}\`` : undefined,
            bank ? `bank \`${bank}\`` : undefined,
            from ? `from \`${from}\`` : undefined,
            to ? `to \`${to}\`` : undefined,
          ]
            .filter(Boolean)
            .join(', ')}.`,
          '3. Report the file name and the row count, and where the file is available.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'import_beneficiaries',
    {
      title: 'Import beneficiaries',
      description: 'Uploads a file, previews and fixes the rows, and commits the import.',
      argsSchema: z.object({}),
    },
    () =>
      user(
        [
          'Import beneficiaries from a file. This needs the beneficiaries profile and `VERIKO_MCP_MAX_RISK=destructive` for the commit.',
          '1. veriko_download_beneficiary_import_template if the user needs the format.',
          '2. veriko_create_beneficiary_import, then veriko_wait_for_beneficiary_import until `preview_ready`.',
          '3. veriko_get_beneficiary_import_preview. Fix `correctable` rows with veriko_patch_beneficiary_import_row and remove `fatal` rows.',
          '4. Show the counts and ask for confirmation before veriko_commit_beneficiary_import.',
        ].join('\n'),
      ),
  );
}
