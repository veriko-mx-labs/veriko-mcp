import { readFileSync } from 'node:fs';

import {
  McpServer,
  type CallToolResult,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { Veriko } from '@veriko-mx/sdk-runtime';

import {
  ArtifactStore,
  describeArtifact,
  isDownloadedFile,
  registerArtifactResources,
  resolveMimeType,
  resourceContents,
  type DownloadedFile,
} from './artifacts.js';
import { confirmOperation } from './confirm.js';
import { callInfoFrom, withErrorHeaders, type CallInfo } from './call-info.js';
import { selectTools, type ToolDefinition, type ToolRuntime } from './catalog.js';
import { clientTuningFromEnv, createClient, withCapture, type CallCapture } from './client.js';
import { type FileAccess } from './local-files.js';
import { loadConfig, type ServerConfig } from './config.js';
import { safeError } from './errors.js';
import { isFileOperation, outputSchemaFor } from './outputs.js';
import { registerPrompts } from './prompts.js';
import { registerReferenceResources } from './resources.js';

function readPackageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string') {
    throw new Error('package.json does not declare a version.');
  }
  return manifest.version;
}

// One source of truth: the version the server announces is the package version.
export const MCP_VERSION = readPackageVersion();

export interface CreateServerOptions {
  config?: ServerConfig;
  client?: Veriko;
  artifacts?: ArtifactStore;
  /**
   * How downloads are delivered.
   *
   * `store` (stdio) keeps the file in process memory and returns a
   * `veriko://artifact/...` link, or embeds it when it is small.
   *
   * `inline` (stateless HTTP) embeds it in the response, because the next
   * request can land on another process and the link would no longer exist.
   */
  artifactMode?: 'store' | 'inline';
  /** Cap, in bytes, of an embedded file (`inline` only). */
  maxInlineArtifactBytes?: number;
  /** Cap, in bytes, of a file embedded in `store` mode. Larger files return a link. */
  maxEmbeddedArtifactBytes?: number;
  /** Language of the API error details for this server; the environment sets it otherwise. */
  acceptLanguage?: 'en' | 'es';
  /** Cap, in characters, of the JSON text block. `structuredContent` is never cut. */
  maxTextChars?: number;
}

export const DEFAULT_MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_EMBEDDED_ARTIFACT_BYTES = 256 * 1024;
export const DEFAULT_MAX_TEXT_CHARS = 64 * 1024;

export const SERVER_INSTRUCTIONS = [
  'Veriko verifies Mexican SPEI transfers against the Banxico CEP. Use the veriko_* tools to operate the public M2M API.',
  'Validating: veriko_validate_direct and veriko_validate_ocr consume quota and answer with a verdict in `attributes.status`. `valid` is a snapshot: use veriko_recheck_validation within 72 hours to detect a return. A `not_found` right away can be a CEP that is not published yet. Check the allowance with veriko_get_usage_limits and fix an account with veriko_validate_account first.',
  'Async: a validation can answer `queued` or `processing` (for example after 45 seconds). Call veriko_wait_for_validation until `terminal` is true; do not loop on veriko_get_validation. The same applies to CEP exports and beneficiary imports.',
  'Idempotency: every write gets a fresh key by default, so repeating a call is a new attempt. To retry safely after a lost response, repeat the call with the same `idempotency_key`; `idempotent_replayed: true` in the result means the stored response was returned.',
  'Errors: a failed call returns `isError` with `code`, `status`, `retryable`, `retry_after_seconds` and the full `errors` list (`detail`, `hint`, `docs_url`, field `pointer`). Branch on `code`. A `429` with `kind: quota` does not clear by waiting seconds.',
  'Downloads come back as embedded resources when small, or as veriko://artifact/* links readable with resources/read. Reference data (banks, SPEI calendar, plans, Banxico status, documentation links) is available as veriko://* resources.',
  'Secrets: webhook signing secrets appear once in the result; do not repeat them. Never ask for or invent an API key; the server reads it from the environment.',
].join('\n\n');

function annotations(tool: ToolDefinition): ToolAnnotations {
  return {
    readOnlyHint: tool.risk === 'read',
    destructiveHint: tool.risk === 'read' ? false : tool.destructive,
    idempotentHint: tool.idempotent,
    openWorldHint: tool.openWorld,
  };
}

function objectResult(value: unknown): Record<string, unknown> {
  if (value === undefined) return { ok: true };
  if (value === null) return { result: null };
  if (Array.isArray(value)) return { data: value };
  if (typeof value === 'object') return { ...(value as Record<string, unknown>) };
  return { result: value };
}

function jsonText(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} characters; the full result is in structuredContent. Narrow the filters or lower per_page/limit.]`;
}

interface Delivery {
  mode: 'store' | 'inline';
  store: ArtifactStore;
  inlineLimit: number;
  embedLimit: number;
  maxTextChars: number;
  notifyListChanged(): void;
}

/** The ways to get a smaller file from this tool, from the arguments it accepts. */
function smallerFileHint(tool: ToolDefinition): string {
  const fields = new Set(Object.keys((tool.inputSchema as unknown as { shape?: object }).shape ?? {}));
  const options: string[] = [];
  if (fields.has('limit')) options.push('lower `limit` to export fewer rows');
  if (fields.has('from') || fields.has('to')) options.push('narrow `from` and `to`');
  if (fields.has('status') || fields.has('bank') || fields.has('banks')) options.push('add a `status` or `bank` filter');
  const narrowing = options.length > 0 ? `${options.join(', ')}; or ` : '';
  const hint = `${narrowing}download it with the local stdio package, or directly from the API with your key.`;
  return hint.charAt(0).toUpperCase() + hint.slice(1);
}

function fileResult(
  file: DownloadedFile,
  delivery: Delivery,
  extra: Record<string, unknown>,
  tool: ToolDefinition,
): CallToolResult {
  const size = file.content.byteLength;
  if (delivery.mode === 'inline' && size > delivery.inlineLimit) {
    const error = {
      code: 'artifact_too_large',
      message: `The ${size}-byte file exceeds the ${delivery.inlineLimit}-byte limit of HTTP mode.`,
      hint: smallerFileHint(tool),
      size,
      limit: delivery.inlineLimit,
      retryable: false,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }

  const mimeType = resolveMimeType(file);
  const reference =
    delivery.mode === 'store' ? delivery.store.put(file) : describeArtifact(file);
  if (delivery.mode === 'store') delivery.notifyListChanged();
  const embed = delivery.mode === 'inline' || size <= delivery.embedLimit;
  const summary = `${reference.name} (${mimeType}, ${size} bytes, sha256 ${reference.sha256})`;
  const structuredContent = { artifact: reference, embedded: embed, ...extra };

  if (!embed) {
    return {
      content: [
        {
          type: 'resource_link',
          uri: reference.uri,
          name: reference.name,
          mimeType,
          description: `${size} bytes; sha256 ${reference.sha256}`,
        },
        { type: 'text', text: `Downloaded ${summary}. Read it at ${reference.uri} with resources/read.` },
      ],
      structuredContent,
    };
  }
  return {
    content: [
      { type: 'resource', resource: resourceContents(reference.uri, mimeType, file.content) },
      { type: 'text', text: `Downloaded ${summary}.` },
    ],
    structuredContent,
  };
}

function successResult(
  value: unknown,
  delivery: Delivery,
  info: CallInfo | undefined,
  tool: ToolDefinition,
): CallToolResult {
  const extra = info ? { _call: info } : {};
  if (isDownloadedFile(value)) return fileResult(value, delivery, extra, tool);
  const structuredContent = { ...objectResult(value), ...extra };
  return {
    content: [{ type: 'text', text: jsonText(structuredContent, delivery.maxTextChars) }],
    structuredContent,
  };
}

function errorResult(error: unknown, runtime: ToolRuntime, captured: CallCapture): CallToolResult {
  const headers =
    (error as { headers?: Record<string, string> } | null)?.headers ?? captured.headers;
  const safe = withErrorHeaders(safeError(error), headers);
  const withKey = runtime.idempotencyKey ? { ...safe, idempotency_key: runtime.idempotencyKey } : safe;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: withKey }) }],
    structuredContent: { error: withKey },
  };
}

/**
 * Sends `notifications/progress` for the running request, when the client asked
 * for them with a `progressToken`. A failed notification never fails the call.
 */
function progressReporter(ctx: ServerContext): ToolRuntime['progress'] {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return async ({ progress, total, message }) => {
    try {
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message ? { message } : {}),
        },
      });
    } catch {
      // The client went away or does not take notifications: the call goes on.
    }
  };
}

export function createVerikoServer(options: CreateServerOptions = {}): McpServer {
  const config = options.config ?? loadConfig();
  const inline = options.artifactMode === 'inline';
  const client =
    options.client ??
    createClient({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      transportName: inline ? 'http' : 'stdio',
      version: MCP_VERSION,
      ...clientTuningFromEnv(),
      ...(options.acceptLanguage ? { acceptLanguage: options.acceptLanguage } : {}),
    });
  const artifacts = options.artifacts ?? new ArtifactStore();
  // Local files are read only in stdio mode and only inside the configured roots.
  const files: FileAccess | undefined =
    !inline && config.fileRoots && config.fileRoots.length > 0 ? { roots: config.fileRoots } : undefined;
  const server = new McpServer(
    {
      name: 'veriko-mcp-server',
      title: 'Veriko',
      version: MCP_VERSION,
      description: 'Verifies Mexican SPEI transfers against the Banxico CEP.',
      websiteUrl: 'https://docs.veriko.mx/en/mcp',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const delivery: Delivery = {
    mode: inline ? 'inline' : 'store',
    store: artifacts,
    inlineLimit: options.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES,
    embedLimit: options.maxEmbeddedArtifactBytes ?? DEFAULT_MAX_EMBEDDED_ARTIFACT_BYTES,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    notifyListChanged() {
      // Best effort: there is no session to notify before the transport connects.
      try {
        server.sendResourceListChanged();
      } catch {
        // Not connected yet.
      }
    },
  };

  if (!inline) registerArtifactResources(server, artifacts);
  registerReferenceResources(server, client);
  registerPrompts(server, client);

  for (const tool of selectTools(config.profiles, config.maxRisk)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: files && tool.localInputSchema ? tool.localInputSchema : tool.inputSchema,
        outputSchema: outputSchemaFor(tool.operationId, tool.helper),
        annotations: annotations(tool),
        _meta: {
          'veriko/operationId': tool.operationId,
          'veriko/family': tool.family,
          'veriko/risk': tool.risk,
          'veriko/cost': tool.cost,
        },
      },
      async (args, ctx) => {
        const runtime: ToolRuntime = {
          signal: ctx.mcpReq.signal,
          files,
          progress: progressReporter(ctx),
        };
        const captured: CallCapture = { responses: 0, signal: ctx.mcpReq.signal };
        try {
          if (tool.confirmation) {
            const confirmation = await confirmOperation(server, ctx, tool.confirmation(args));
            if (!confirmation.proceed) return confirmation.result;
          }
          if (isFileOperation(tool.operationId)) {
            await runtime.progress?.({ progress: 0, total: 2, message: 'Requesting the file from Veriko' });
          }
          const value = await withCapture(captured, () => tool.invoke(client, args, runtime));
          if (isDownloadedFile(value)) {
            await runtime.progress?.({
              progress: 1,
              total: 2,
              message: `Received ${value.content.byteLength} bytes; preparing the result`,
            });
          }
          return successResult(
            value,
            delivery,
            callInfoFrom(captured.meta, runtime.idempotencyKey),
            tool,
          );
        } catch (error) {
          return errorResult(error, runtime, captured);
        }
      },
    );
  }

  return server;
}
