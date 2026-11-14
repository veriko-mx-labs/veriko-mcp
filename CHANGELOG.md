# Changelog

## [0.2.0] - 2026-11-13

### Added

- Tools `veriko_validate_account`, `veriko_wait_for_validation`, `veriko_wait_for_cep_export` and
  `veriko_wait_for_beneficiary_import`. The wait tools poll until the resource reaches a terminal
  status, honor `next_poll_after_seconds` and `Retry-After`, and use `ETag` so an unchanged resource
  costs a `304`.
- Covers 73 of the 75 public M2M operations. The two purge operations stay unexposed.
- `outputSchema` and `structuredContent` on every tool, with a `_call` object that carries the
  request id, `Idempotent-Replayed` and the quota headers.
- Optional `idempotency_key` on every write, and `idempotent_replayed` in the result.
- `immediate` on `veriko_regenerate_webhook_secret`, and `recipient_is_bank` on OCR validation.
- Resources `veriko://catalog/banks`, `veriko://catalog/spei-calendar/{year}`, `veriko://plans`,
  `veriko://status/banxico` and `veriko://docs`.
- Prompts `check_transfer`, `reconcile_month`, `triage_failed_validations`, `set_up_webhook` and
  `import_beneficiaries`.
- Downloads return embedded resources up to 256 KiB and `resource_link` above that, with a MIME type
  inferred for `application/octet-stream`.
- Environment variables `VERIKO_TIMEOUT_MS`, `VERIKO_MAX_RETRIES` and `VERIKO_ACCEPT_LANGUAGE`.
- Evals for write tools, asynchronous flows, error results, a CEP export wait and confirmed or
  declined deletes.
- Confirmation through elicitation before `veriko_delete_validation`, `veriko_delete_webhook`,
  `veriko_regenerate_webhook_secret`, `veriko_delete_beneficiary`,
  `veriko_delete_beneficiary_import_row`, `veriko_commit_beneficiary_import` and the two
  retry-policy updates, when the client declares the `elicitation` capability. A declined question
  returns `executed: false` and sends nothing to the API.
- Progress notifications from the wait tools and downloads when the request carries a
  `progressToken`, and cancellation that aborts the call in flight, its retries and the pause
  between polls. A cancelled call returns the code `cancelled`.
- Argument completion for bank codes, validation statuses, webhook events, export formats and the
  SPEI calendar year. New resource template `veriko://catalog/banks/{code}` and prompt
  `export_validations`.
- `image_path` on `veriko_validate_ocr` and `file_path` on `veriko_create_beneficiary_import`, over
  stdio only and inside the directories of `VERIKO_MCP_FILE_ROOTS`.
- `rate_limit`, `deprecation` and `sunset` in `_call`, read from the SDK response metadata.
- HTTP headers `X-Veriko-Profile`, `X-Veriko-Max-Risk` (both can only narrow the server settings)
  and `Accept-Language` (`en` or `es`).
- `artifact_too_large` carries `size`, `limit` and a `hint` that names the arguments that make the
  file smaller.
- A test that fails when the `tools/list` size of a profile passes its budget.
- `server.json` lists every environment variable.

### Changed

- Everything the server shows is in English: tool titles and descriptions, server instructions,
  input field names (`validation_id`, `with_deleted`, `retry_policy`, and so on, as the API names
  them), errors, README, SECURITY and the evals. Tool names are unchanged.
- Every input field has a description, and enums, minimums, maximums and required fields follow the
  public contract. `with_deleted` and `with_archived` take `0` or `1`, as in the API.
- Idempotency keys are random per call. They are no longer derived from the arguments, so repeating
  the same call is a new attempt unless you pass the same `idempotency_key`.
- Errors return `isError` with the full `errors` list, the status, `retryable`, `retry_after_seconds`
  and `request_id`. A `304` is not an error. An exhausted quota or a rate limit returns at once with
  `retry_after_seconds`.
- `veriko_get_usage_limits` belongs to the `core` profile, and quota warnings are in English.
- Annotations are consistent per operation: `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint`.
- The `User-Agent` is `veriko-mcp/<version> (<transport>) veriko-sdk-js/<version> (...)`.
- Uses JavaScript SDK `0.6.0`.
- The `_call` output schema is compact, so `tools/list` of the `all` profile is 148 KB.
- HTTP transport validates the `Host` header against a list (new variable
  `VERIKO_MCP_ALLOWED_HOSTS`, required if the server listens outside `127.0.0.1`) and, with
  `VERIKO_MCP_ALLOWED_ORIGINS` empty, rejects every request that arrives with `Origin`.
- HTTP transport answers 401 to a key that does not have the shape of a Veriko key before processing
  the request, and 413 to a body declared larger than the cap, without reading it.

### Fixed

- Finance tools no longer accept the admin-only `userId`.
- The JSON text of a result is capped at 64 KiB; `structuredContent` is never cut.
- The wait tools pace their polls with `meta.next_poll_after_seconds` from the response body, and
  not only with `Retry-After`.

## [0.1.14] - 2026-11-09

- Uses JavaScript SDK 0.5.4 and public spec 1.181.7. With the new SDK, an API key that is not
  `veriko_` followed by 64 lowercase hexadecimal characters fails before leaving for the network, without
  including the key in the message.
- `validateDirect` rejects an amount of more than 13 integer digits, as the contract does.

## [0.1.13] - 2026-11-08

- Stateless Streamable HTTP transport, in addition to stdio (new executable `veriko-mcp-http`). The
  integrator API key travels as `Authorization: Bearer` on every request and is not stored.
  Over HTTP, downloads are embedded in the response (8 MB cap) instead of using
  `veriko://artifact/` links that depend on process memory. The stdio mode does not change.
- The version the server announces comes from `package.json` (it used to report `0.1.1`).
- README: install command with `npx`, and the mention of ChatGPT is removed, because it does not support local MCP servers over stdio.
- Tools to export CEPs in the background: `createFinanceCepExport`, `listFinanceCepExports`,
  `getFinanceCepExport` and `downloadFinanceCepExport`.
- `validateDirect` accepts a validation without a send date: if it is missing or unusable, the API tries
  candidate dates against Banxico.
- Uses JavaScript SDK `0.5.2` (public contract `1.168.2`).

## [0.1.12] - 2026-10-27

- `myProfile` follows contract `1.111.0`: it no longer returns `role`, adds `platform_access` and
  `roles`, and the `permissions` keys have the form `validations.records.read`.
- Uses JavaScript SDK `0.5.0` (public contract `1.111.0`).

## [0.1.11] - 2026-10-15

- `createBeneficiary` returns `reactivated`: `true` when the creation reactivated an archived account with
  the same number, and `false` for a new one.
- Uses JavaScript SDK `0.4.14` (public contract `1.76.2`).

## [0.1.10] - 2026-10-15

- Tool `getSpeiCalendar`: returns the non-business SPEI days of a year and the official provision
  they come from. It accepts `ifNoneMatch`. It does not consume quota.
- `validateOcr` accepts the sender and receiver bank codes: the 4 or 5 digit SPEI key replaces
  the bank read from the receipt before querying Banxico.
- `listValidations`, `validationStats` and `exportValidations` accept `banks`, up to 50 SPEI
  keys; it filters by sender or receiver bank.
- The four delivery tools accept `responseStatus`, `validationId`, `q`, `from`, `to`,
  `minAttempt` and `minResponseTimeMs`, and `status`, `eventType` and `responseStatus` accept a
  list. `listAllDeliveries` and `exportAllDeliveries` accept `endpointIds`, up to 20 endpoints.
- Uses JavaScript SDK `0.4.13` (public contract `1.76.0`).

## [0.1.9] - 2026-10-02

- Tool `recheckValidation`: queries Banxico again for the payment status of a `valid`
  validation created at most 72 hours ago, and moves it to `returned` if the payment was
  returned. It does not consume quota.
- `validateDirect` and `validateOcr` accept `candidate_accounts`, several accounts in a single
  validation and with a single unit of quota, instead of `beneficiary_account`. `validateDirect`
  requires one of the two forms, not both.
- `validateOcr` accepts `retainImage`; with `false`, the platform does not keep the receipt
  file.
- Webhooks can subscribe to the `validation.returned` event.
- Uses JavaScript SDK `0.4.12` (public contract `1.61.0`).

## [0.1.8] - 2026-10-01

- `validateDirect` requires `beneficiary_account`: the API does not look it up among the saved
  beneficiaries.
- `validateDirect`, `validateOcr`, `listValidations`, `validationStats` and `exportValidations`
  accept `clientRef`, your own reference of 1 to 64 characters. In the first two it comes back in the
  validation and in webhooks; in the other three it filters by exact match.
- Uses JavaScript SDK `0.4.11` (public contract `1.60.0`).

## [0.1.7] - 2026-09-29

- Uses JavaScript SDK `0.4.10` (public contract `1.60.0`): its types document the per-field
  codes of the validation `422` (the CLABE and card mismatch codes and the tracking key
  length code) and clarify that no `preflight_failed` rejection on that route
  consumes quota.

## [0.1.6] - 2026-09-28

- Uses JavaScript SDK `0.4.9` (public contract `1.60.0`): the usage summary distinguishes a trial
  quota (`quota_kind`) and whether it renews (`renews`).

## [0.1.5] - 2026-09-27

- `validateOcr` accepts the receipt as a PDF, and `getValidationImage` returns it as a resource with
  its `application/pdf` type.
- Uses JavaScript SDK `0.4.8` (public contract `1.60.0`).

## [0.1.4] - 2026-09-26

- Uses JavaScript SDK `0.4.7` (public contract `1.60.0`).

## [0.1.3] - 2026-09-24

- Tool parameters apply the limits of the public contract:
  maximum text length, format of accounts and bank keys, and caps
  on `limit`. An out-of-range value is rejected before calling the API.
- `format` is required when downloading the beneficiary import template
  (`downloadBeneficiaryImportTemplate`), as in the API.
- Uses JavaScript SDK `0.4.6` (public contract `1.60.0`).

## [0.1.2] - 2026-09-23

No API changes. Updates documentation and metadata.

## [0.1.1] - 2026-09-20

No surface changes.

## [0.1.0] - 2026-09-20

First version on npm.

- Catalog of 66 public M2M operations on the JavaScript SDK, imported
  through the stable alias `@veriko-mx/sdk-runtime`.
- The SDK is consumed from npm (`npm:@veriko-mx/sdk@0.4.4`) with its integrity in
  the lockfile.
- Profiles by family and an independent risk policy.
- Deterministic idempotency for compatible operations.
- Downloads as ephemeral MCP resources.
- Local `stdio` transport on the official MCP SDK v2.
- Binary limits verified end to end: 12 MB for OCR and 20 MB for
  imports, with a 32 MB stdio buffer.
