# Veriko MCP

The Veriko MCP server connects Veriko to Cursor or any other MCP-compatible
client. Ask the assistant to check a payment against the Banxico CEP, to tell
you what became of an earlier validation, or to download the receipt.

The server covers 73 of the 75 public machine-to-machine operations as tools.
It leaves out the two purge operations (`prepare` and `execute`), because a
permanent deletion cannot be undone. Three more tools wait for an asynchronous
result: `veriko_wait_for_validation`, `veriko_wait_for_cep_export` and
`veriko_wait_for_beneficiary_import`. That makes 76 tools in the `all` profile.

<!-- mcp-name: io.github.veriko-mx-labs/veriko -->

## Install

Requires Node.js 20 or later. Without cloning anything, the client starts the
server with `npx`:

```bash
npx -y @veriko-mx/mcp
```

In a host that accepts JSON configuration (Cursor and similar):

```json
{
  "mcpServers": {
    "veriko": {
      "command": "npx",
      "args": ["-y", "@veriko-mx/mcp"],
      "env": { "VERIKO_API_KEY": "veriko_..." }
    }
  }
}
```

## Try it from source

```bash
git clone https://github.com/veriko-mx-labs/veriko-mcp.git
cd veriko-mcp
npm ci
npm run build
```

This leaves a runnable server at `dist/index.js`. To see it answer without an
API key, the public plans profile needs no credentials:

```bash
VERIKO_MCP_PROFILE=plans VERIKO_MCP_MAX_RISK=read node dist/index.js
```

The process waits for MCP messages on stdin; your client normally starts it.
This is the host configuration, with the absolute path to the copy you just
built:

```json
{
  "mcpServers": {
    "veriko": {
      "command": "node",
      "args": ["/path/to/veriko-mcp/dist/index.js"],
      "env": {
        "VERIKO_API_KEY": "veriko_...",
        "VERIKO_MCP_PROFILE": "core",
        "VERIKO_MCP_MAX_RISK": "write"
      }
    }
  }
}
```

Get the key at `app.veriko.mx`. The key is never a tool argument: the server
reads it only from `VERIKO_API_KEY`, so text injected into a page the model is
reading cannot ask for it. The tools that read public data (`plans` profile,
Banxico status, bank catalog) work without a key.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `VERIKO_API_KEY` | Integrator API key (`veriko_` followed by 64 hexadecimal characters) | none |
| `VERIKO_MCP_PROFILE` | `core`, `all`, one family or several families separated by commas | `core` |
| `VERIKO_MCP_MAX_RISK` | Highest risk advertised: `read`, `write` or `destructive` | `write` |
| `VERIKO_BASE_URL` | API base URL (HTTPS; HTTP only for `localhost`) | production API |
| `VERIKO_TIMEOUT_MS` | Timeout per request, from 1,000 to 300,000 | 60,000 |
| `VERIKO_MAX_RETRIES` | Automatic retries of transient failures, from 0 to 5 | 2 |
| `VERIKO_ACCEPT_LANGUAGE` | Language of the API error text: `en` or `es` | `en` |
| `VERIKO_MCP_FILE_ROOTS` | Absolute directories, separated by the platform path delimiter, that `image_path` and `file_path` may read from (stdio only) | none |

## What consumes quota

`veriko_validate_direct` and `veriko_validate_ocr` consume plan quota, charged
when the API accepts the request. Each description says so, because an agent
loop can empty a monthly quota in minutes. The result reports the remaining
allowance, and the text warns when it runs low. The rest of the catalog queries,
exports or downloads without consuming validations.

Check the allowance first with `veriko_get_usage_limits`, which belongs to the
`core` profile.

## Profiles

`VERIKO_MCP_PROFILE` accepts `core`, `all`, one family or several families
separated by commas.

| Profile | Advertised tools |
|---|---|
| `core` | validate, validate an account, list, get, wait for and download a CEP, usage limits |
| `validations` | full validation lifecycle |
| `webhooks` | endpoints, deliveries and secrets |
| `catalog` | banks, SPEI calendar, BIN and Banxico status |
| `beneficiaries` | list and bulk import |
| `usage` | consumption, limits and export |
| `account` | profile and retry policy |
| `dashboard` | operational summary |
| `plans` | public plans |
| `insights` | aggregated metrics |
| `finance` | summaries, previews, downloads and CEP exports |
| `billing` | active subscription |
| `all` | all 76 tools |

The profile decides which families the model sees. Risk is controlled
independently with `VERIKO_MCP_MAX_RISK`:

- `read`: queries and downloads only;
- `write` (default): adds validations and ordinary changes;
- `destructive`: adds deletions, cancellations, secret rotation and import
  confirmation.

### What advertising each profile costs

Advertising a tool spends context before the model calls anything. These
figures come from the server itself: bytes of the `tools/list` response, from
`npm run measure:catalog`. Tokens are an estimate at 3.6 bytes per token, not a
real tokenization, and serve to compare profiles with each other. The figures
include each tool's output schema.

| Profile | Tools | Bytes of `tools/list` | Estimated tokens |
|---|---:|---:|---:|
| `core` | 8 | 25,536 | ~7,093 |
| `validations` | 15 | 43,152 | ~11,987 |
| `webhooks` | 10 | 29,012 | ~8,059 |
| `catalog` | 5 | 6,554 | ~1,821 |
| `beneficiaries` | 16 | 26,254 | ~7,293 |
| `usage` | 7 | 8,661 | ~2,406 |
| `account` | 3 | 4,696 | ~1,304 |
| `dashboard` | 1 | 1,198 | ~333 |
| `plans` | 2 | 2,097 | ~583 |
| `insights` | 4 | 4,834 | ~1,343 |
| `finance` | 12 | 20,202 | ~5,612 |
| `billing` | 1 | 1,049 | ~291 |
| `all` | 76 | 147,699 | ~41,028 |

Measured with Node 22 and risk `destructive`, so that no tool is hidden. `all`
costs 5.8 times what `core` does; for that reason the default profile is `core`
and families are added when needed. `test/tools-list-size.test.ts` fails when a
profile grows past its budget.

## Behavior of the tools

- **Names and inputs.** Tools are named `veriko_<operationId in snake_case>`.
  The prefix keeps the names unique in a host that connects several servers, and
  the names do not change between releases. Input fields use the API's English names in `snake_case`, each with a
  description, and the enums, minimums and maximums of the public contract.
- **Structured output.** Every tool declares an `outputSchema` and returns
  `structuredContent` plus the same JSON as text. A `_call` object carries the
  request id, the `Idempotent-Replayed` flag, the quota, the rate-limit window,
  `retry_after_seconds` and, when the API announces it, `deprecation` and
  `sunset`. Text is capped at 64 KiB; `structuredContent` is never cut.
- **Idempotency.** Each write sends a random `Idempotency-Key` per call. To retry
  safely after a lost response, repeat the call with the same
  `idempotency_key`; `idempotent_replayed: true` means the API returned the
  stored response.
- **Asynchronous results.** A validation can answer `queued` or `processing`.
  `veriko_wait_for_validation`, `veriko_wait_for_cep_export` and
  `veriko_wait_for_beneficiary_import` poll until the resource reaches a
  terminal status or the wait ends (25 seconds by default, up to 40). They honor
  `next_poll_after_seconds` and `Retry-After`, and answer `terminal: false` with
  the interval when time runs out. Conditional reads that return `304` come back
  as `{ "not_modified": true, "etag": ... }`, not as errors.
- **Errors.** A failed call returns `isError` with `code`, `status`,
  `retryable`, `retry_after_seconds`, `request_id` and the full `errors` list
  (`code`, `title`, `detail`, `hint`, `docs_url`, `pointer`, `meta`). A `429`
  from an exhausted quota (`kind: quota`) and a rate limit (`kind: rate_limit`)
  return at once, with `retry_after_seconds`; the server does not sleep through
  them.
- **Confirmation.** When the client declares the `elicitation` capability, the
  server asks before `veriko_delete_validation`, `veriko_delete_webhook`,
  `veriko_regenerate_webhook_secret`, `veriko_delete_beneficiary`,
  `veriko_delete_beneficiary_import_row`, `veriko_commit_beneficiary_import`,
  `veriko_update_validation_retry_policy` and `veriko_update_my_retry_policy`.
  A declined or dismissed question returns `executed: false` with the `reason`,
  and nothing is sent to the API. A client without the capability runs the
  operation, and `VERIKO_MCP_MAX_RISK` remains the gate.
- **Progress and cancellation.** When the request carries a `progressToken`, the
  wait tools send one `notifications/progress` per poll, and downloads send one
  when the request starts and one when the file arrives. Cancelling the request
  aborts the call in flight, its retries and the pause between polls; the result
  is `cancelled`.
- **Downloads.** Files return as embedded resources up to 256 KiB, and as
  `veriko://artifact/...` links above that (stdio), with the right MIME type. The
  server infers the type of an `application/octet-stream` download from the
  extension and the leading bytes.
- **Limits.** The server validates canonical base64 and the public limits before
  calling the SDK: 12 MB for OCR receipts (image or PDF) and 20 MB for
  beneficiary imports. The stdio transport accepts a maximum import in full.
- **Local files.** Over stdio, set `VERIKO_MCP_FILE_ROOTS` and
  `veriko_validate_ocr` accepts `image_path`, and `veriko_create_beneficiary_import`
  accepts `file_path`, instead of base64. The path must be absolute and, once
  links are resolved, inside one of the roots. The server checks the size limits
  above, the leading bytes of a receipt (JPEG, PNG, WebP or PDF) and the
  extension of an import file before it sends anything. Without the variable the
  arguments are not advertised, and the HTTP server never advertises or reads them.
- **Completion.** Prompt arguments and resource template variables answer
  `completion/complete`: validation statuses, webhook events and export formats
  come from the spec enums, bank codes from the public bank catalog (by code, name
  or alias), and the year of the SPEI calendar from the current year.
- **User agent.** Requests send
  `veriko-mcp/<version> (<transport>) veriko-sdk-js/<version> (...)`.

### Resources

| URI | Content |
|---|---|
| `veriko://catalog/banks` | SPEI bank catalog |
| `veriko://catalog/banks/{code}` | One SPEI bank by its 5-digit code |
| `veriko://catalog/spei-calendar/{year}` | Non-business SPEI days of a year |
| `veriko://plans` | Public plans |
| `veriko://status/banxico` | Banxico service status |
| `veriko://docs` | Links to the documentation at `https://docs.veriko.mx/en/` |
| `veriko://artifact/...` | Files downloaded in the current session (stdio) |

### Prompts

`check_transfer`, `reconcile_month`, `triage_failed_validations`,
`set_up_webhook`, `export_validations` and `import_beneficiaries` start a guided flow with the real
tools of the catalog.

## Architecture

- It uses the official JavaScript SDK as the only transport layer to the API.
  The code imports it through `@veriko-mx/sdk-runtime`, a stable alias that
  allows changing the distribution source without rewriting the server.
- The runtime SDK ships inside the MCP tarball.
- It advertises tools by profile and risk.
- Errors use `error.code`, status, pointer, request id and retry interval when
  they exist; the API's translatable text is not a contract.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:surface
npm run measure:catalog
npm run evals
```

`check:surface` compares the full catalog against the SDK's public spec and pins
its SHA-256. The operations the catalog does not advertise, the two purge
operations, are declared apart in `NOT_EXPOSED_OPERATIONS`. A new, removed or
hidden operation, an authentication scheme other than the API key, or any
contract change fails this check. The sync workflow opens the PR for the new
contract as a draft, with CI run and a summary of the change in the body, for
review before accepting it.

The tests do not use the real API. `test/server.test.ts` connects an MCP client
and server in memory with a fake SDK; `test/http.test.ts` starts the HTTP mode on
a local port. `npm run evals` runs the scenarios in `evals/` against a fake API.

## Transports

The core lives in `createVerikoServer()` and does not depend on the transport.
There are two:

- **stdio** (`veriko-mcp`): the client starts it as a local process and the key
  is read from `VERIKO_API_KEY`. Downloads are `veriko://artifact/...`
  resources or embedded resources.
- **Stateless Streamable HTTP** (`veriko-mcp-http`): an endpoint that can sit
  behind a proxy. There are no sessions and no memory between requests.

### HTTP mode

```bash
npm run build
VERIKO_MCP_HTTP_PORT=3000 node dist/http-index.js
```

It listens on `127.0.0.1:3000/mcp`; `GET /healthz` answers without
authentication.

- **Authentication.** Every request carries the integrator API key as
  `Authorization: Bearer <key>`. Without it, or if it does not have the shape of
  a Veriko key, the answer is 401. The server creates a new client per request,
  does not store or log the key, and ignores `VERIKO_API_KEY` from the
  environment, so a server key is never used on behalf of someone else.
- **Downloads.** Because the next request can land on another process, the file
  is not stored: it travels embedded in the response as a resource with a base64
  `blob`, capped at 8 MB. Beyond that it returns the `artifact_too_large` error
  with the size, the limit and a `hint`: lower `limit`, narrow `from` and `to`,
  add a filter, or use stdio or the API.
- **Host and Origin.** The `Host` header must be in `VERIKO_MCP_ALLOWED_HOSTS`;
  without it only `localhost`, `127.0.0.1` and `[::1]` are accepted, and the
  server does not start if it listens on another address. A request with
  `Origin` (browser requests) passes only if that origin is in
  `VERIKO_MCP_ALLOWED_ORIGINS`; non-browser clients do not send it.
- **Body size.** A body declared larger than the cap is rejected with 413
  without being read.
- **Profiles and risk.** `VERIKO_MCP_PROFILE` and `VERIKO_MCP_MAX_RISK` apply to
  the whole server, as in stdio. A request can narrow them with
  `X-Veriko-Profile` and `X-Veriko-Max-Risk`; a wider value answers 403 and an
  unknown one 400. The checks run after the `Host`, `Origin` and key checks.
- **Language.** `Accept-Language` (`en` or `es`) sets the language of the API
  error text for that request.

| Variable | Description | Default |
|---|---|---|
| `VERIKO_MCP_HTTP_PORT` | Port | `3000` |
| `VERIKO_MCP_HTTP_HOST` | Listen address | `127.0.0.1` |
| `VERIKO_MCP_HTTP_PATH` | Endpoint path | `/mcp` |
| `VERIKO_MCP_ALLOWED_HOSTS` | Host names accepted in `Host`, without port, separated by commas; required if it listens outside `127.0.0.1` | `localhost`, `127.0.0.1`, `[::1]` |
| `VERIKO_MCP_ALLOWED_ORIGINS` | Allowed browser origins (`https://app.example.com`), separated by commas; empty rejects every request with `Origin` | empty |
| `VERIKO_MCP_HTTP_MAX_BODY_BYTES` | Maximum body size | 32 MiB |
| `VERIKO_MCP_HTTP_MAX_INLINE_BYTES` | Cap of an embedded file | 8 MiB |

The server does not terminate TLS: deploy it behind an HTTPS proxy. Until OAuth
exists for customer accounts, the API key is the only credential.

## Security

See [SECURITY.md](SECURITY.md). Never open issues with API keys, real payloads,
receipts, account numbers or unsanitized responses.

## License

MIT.
