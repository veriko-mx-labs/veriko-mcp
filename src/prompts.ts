import { completable, type McpServer } from '@modelcontextprotocol/server';
import type { Veriko } from '@veriko-mx/sdk-runtime';
import { z } from 'zod';

import { bankCompleter, completeEvent, completeFormat, completeStatus } from './completions.js';

function user(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** Flujos reutilizables. Cada uno nombra las herramientas que necesita; algunos requieren un `VERIKO_MCP_PROFILE` más amplio. */
export function registerPrompts(server: McpServer, client: Veriko): void {
  const bankCode = bankCompleter(client);
  server.registerPrompt(
    'check_transfer',
    {
      title: 'Revisar una transferencia y explicar el veredicto',
      description: 'Valida una transferencia SPEI y explica el veredicto, sus salvedades y el siguiente paso.',
      argsSchema: z.object({
        details: z
          .string()
          .describe('Lo que se sabe: monto, clave de rastreo o referencia numérica, cuenta beneficiaria, fecha de envío o la URL de un comprobante.'),
        beneficiary_bank: completable(z.string().regex(/^\d{4,5}$/).describe('Código SPEI del banco beneficiario, si se conoce.'), bankCode).optional(),
      }),
    },
    ({ details, beneficiary_bank }) =>
      user(
        [
          `Revisa esta transferencia SPEI: ${details}${beneficiary_bank ? ` (banco beneficiario ${beneficiary_bank})` : ''}`,
          '',
          '1. Si se da un número de cuenta, llama primero a veriko_validate_account y corrígelo si `checksum_valid` es false.',
          '2. Llama a veriko_get_usage_limits y detente a preguntar si la cuota restante es poca: cada validación consume cuota.',
          '3. Llama a veriko_validate_direct (o a veriko_validate_ocr si es un comprobante). No repitas la llamada con los mismos argumentos, salvo que reutilices su `idempotency_key`.',
          '4. Si el estado es `queued` o `processing`, llama a veriko_wait_for_validation hasta que `terminal` sea true.',
          '5. Explica el veredicto. Un `not_found` puede significar que Banxico aún no publica el CEP; ofrece una política de reintentos. Si `account_cross_checked` es false, aclara que `valid` confirma que la transferencia existe, pero no que se pagó a la cuenta esperada.',
          '6. Ofrece veriko_download_cep y, dentro de las 72 horas, veriko_recheck_validation para detectar una devolución.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'reconcile_month',
    {
      title: 'Conciliar un mes',
      description: 'Resume las validaciones y las finanzas de un mes y señala lo que requiere atención.',
      argsSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe('Mes en formato AAAA-MM.') }),
    },
    ({ month }) =>
      user(
        [
          `Concilia ${month}. Esto requiere los perfiles finance y validations.`,
          '1. veriko_get_finance_summary del mes.',
          '2. veriko_validation_stats con `from` y `to` en el mes y luego veriko_list_validations para las filas `returned`, `failed` y `error`.',
          '3. Las vistas previas de veriko_get_finance_by_bank y veriko_get_finance_counterparties para las mayores diferencias.',
          '4. Informa los totales, los pagos devueltos y las filas por revisar. Ofrece un CSV con veriko_get_finance_accounting.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'triage_failed_validations',
    {
      title: 'Revisar las validaciones fallidas',
      description: 'Encuentra las validaciones que no terminaron en un veredicto y propone una solución para cada grupo.',
      argsSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha de inicio, AAAA-MM-DD.'),
        status: completable(z.string().describe('Revisa primero un estado, por ejemplo `not_found`.'), completeStatus).optional(),
      }),
    },
    ({ from, status }) =>
      user(
        [
          `Revisa las validaciones que fallaron${from ? ` desde ${from}` : ' recientemente'}. Esto requiere el perfil validations.`,
          status
            ? `1. veriko_list_validations con el estado \`${status}\` primero y luego con los demás estados fallidos (\`failed\`, \`error\`, \`cep_unavailable\`, \`not_found\`).`
            : '1. veriko_list_validations con los estados `failed`, `error` y `cep_unavailable`, y luego `not_found`.',
          '2. Agrupa por `error_code`. Para `cep_unavailable`, revisa veriko_banxico_public_status.',
          '3. Para `not_found`, lee veriko_list_validation_retry_attempts y propón veriko_update_validation_retry_policy cuando no haya un reintento en curso.',
          '4. Resume cada grupo y pregunta antes de cambiar cualquier política.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'set_up_webhook',
    {
      title: 'Configurar y probar un webhook',
      description: 'Registra un webhook, lo prueba y revisa la entrega.',
      argsSchema: z.object({
        url: z.string().url().describe('URL HTTPS que recibe los eventos.'),
        event: completable(z.string().describe('Un evento al que suscribirse, por ejemplo `validation.completed`.'), completeEvent).optional(),
      }),
    },
    ({ url, event }) =>
      user(
        [
          `Configura un webhook para ${url}. Esto requiere el perfil webhooks.`,
          `1. veriko_create_webhook con ${event ? `el evento \`${event}\` y los demás` : 'los'} eventos que necesite la persona. El secreto de firma aparece una sola vez: dile que lo guarde y no lo repitas.`,
          '2. veriko_send_webhook_test y luego veriko_list_webhook_deliveries para leer la respuesta del receptor.',
          '3. Si el secreto quedó expuesto, veriko_regenerate_webhook_secret con `immediate: true`.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'export_validations',
    {
      title: 'Exportar validaciones',
      description: 'Exporta las validaciones de un periodo, filtradas por estado o banco, como archivo CSV o XLSX.',
      argsSchema: z.object({
        format: completable(z.string().describe('`csv` (por omisión) o `xlsx`.'), completeFormat).optional(),
        status: completable(z.string().describe('Sólo este estado, por ejemplo `returned`.'), completeStatus).optional(),
        bank: completable(z.string().describe('Sólo este código de banco SPEI.'), bankCode).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha de inicio, AAAA-MM-DD.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha de fin, AAAA-MM-DD.'),
      }),
    },
    ({ format, status, bank, from, to }) =>
      user(
        [
          `Exporta las validaciones como ${format ?? 'csv'}.`,
          '1. Llama a veriko_validation_stats con los mismos filtros para ver cuántas filas tendrá el archivo.',
          `2. Llama a veriko_export_validations con ${[
            `format \`${format ?? 'csv'}\``,
            status ? `status \`${status}\`` : undefined,
            bank ? `bank \`${bank}\`` : undefined,
            from ? `from \`${from}\`` : undefined,
            to ? `to \`${to}\`` : undefined,
          ]
            .filter(Boolean)
            .join(', ')}.`,
          '3. Informa el nombre del archivo y el número de filas, y dónde está disponible el archivo.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'import_beneficiaries',
    {
      title: 'Importar beneficiarios',
      description: 'Sube un archivo, revisa y corrige las filas en la vista previa y confirma la importación.',
      argsSchema: z.object({}),
    },
    () =>
      user(
        [
          'Importa beneficiarios desde un archivo. Esto requiere el perfil beneficiaries y `VERIKO_MCP_MAX_RISK=destructive` para la confirmación.',
          '1. veriko_download_beneficiary_import_template si la persona necesita el formato.',
          '2. veriko_create_beneficiary_import y luego veriko_wait_for_beneficiary_import hasta `preview_ready`.',
          '3. veriko_get_beneficiary_import_preview. Corrige las filas `correctable` con veriko_patch_beneficiary_import_row y quita las filas `fatal`.',
          '4. Muestra los conteos y pide confirmación antes de veriko_commit_beneficiary_import.',
        ].join('\n'),
      ),
  );
}
