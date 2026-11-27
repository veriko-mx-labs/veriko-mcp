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
import { acceptingFormerNames } from './legacy-names.js';
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
    throw new Error('package.json no declara una versión.');
  }
  return manifest.version;
}

// Una sola fuente de verdad: la versión que anuncia el servidor es la del paquete.
export const MCP_VERSION = readPackageVersion();

export interface CreateServerOptions {
  config?: ServerConfig;
  client?: Veriko;
  artifacts?: ArtifactStore;
  /**
   * Cómo se entregan las descargas.
   *
   * `store` (stdio) guarda el archivo en la memoria del proceso y devuelve un
   * enlace `veriko://artifact/...`, o lo incrusta cuando es pequeño.
   *
   * `inline` (HTTP sin estado) lo incrusta en la respuesta, porque la siguiente
   * petición puede caer en otro proceso y el enlace ya no existiría.
   */
  artifactMode?: 'store' | 'inline';
  /** Tope, en bytes, de un archivo incrustado (sólo `inline`). */
  maxInlineArtifactBytes?: number;
  /** Tope, en bytes, de un archivo incrustado en modo `store`. Un archivo mayor devuelve un enlace. */
  maxEmbeddedArtifactBytes?: number;
  /** Idioma del detalle de los errores de la API para este servidor; si no se indica, lo fija el entorno. */
  acceptLanguage?: 'en' | 'es';
  /** Tope, en caracteres, del bloque de texto JSON. `structuredContent` nunca se recorta. */
  maxTextChars?: number;
}

export const DEFAULT_MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_EMBEDDED_ARTIFACT_BYTES = 256 * 1024;
export const DEFAULT_MAX_TEXT_CHARS = 64 * 1024;

export const SERVER_INSTRUCTIONS = [
  'Veriko verifica transferencias SPEI de México contra el CEP de Banxico. Usa las herramientas veriko_* para operar la API pública de máquina a máquina.',
  'Validar: veriko_validate_direct y veriko_validate_ocr consumen cuota y responden con un veredicto en `attributes.status`. `valid` es una fotografía: usa veriko_recheck_validation dentro de las 72 horas para detectar una devolución. Un `not_found` inmediato puede ser un CEP que aún no se publica. Con `error_code` `tracking_key_truncated`, el comprobante muestra la clave de rastreo cortada: pide la clave completa y no reintentes. Con `other_account_exists`, hay un pago a otra cuenta que muestra el comprobante, no a la enviada. `attributes.truncated_fields` lista los campos cortados. Antes, consulta el saldo con veriko_get_usage_limits y corrige la cuenta con veriko_validate_account.',
  'Asíncrono: una validación puede responder `queued` o `processing` (por ejemplo, después de 45 segundos). Llama a veriko_wait_for_validation hasta que `terminal` sea true; no consultes en bucle veriko_get_validation. Lo mismo aplica a las exportaciones de CEP y a las importaciones de beneficiarios.',
  'Idempotencia: cada escritura recibe una clave nueva por omisión, así que repetir una llamada es un intento nuevo. Para reintentar sin riesgo tras una respuesta perdida, repite la llamada con la misma `idempotency_key`; `idempotent_replayed: true` en el resultado significa que se devolvió la respuesta guardada.',
  'Errores: una llamada fallida devuelve `isError` con `code`, `status`, `retryable`, `retry_after_seconds` y la lista completa `errors` (`detail`, `hint`, `docs_url`, `pointer` del campo). Decide según `code`. Un `429` con `kind: quota` no se resuelve esperando unos segundos.',
  'Las descargas llegan como recursos incrustados cuando son pequeñas, o como enlaces veriko://artifact/* que se leen con resources/read. Los datos de referencia (bancos, calendario SPEI, planes, estado de Banxico, enlaces a la documentación) están disponibles como recursos veriko://*.',
  'Secretos: los secretos de firma de los webhooks aparecen una sola vez en el resultado; no los repitas. Nunca pidas ni inventes una clave de API; el servidor la lee del entorno.',
].join('\n\n');

/** En HTTP sin estado no hay enlaces que leer después: cada descarga llega completa dentro del resultado. */
const INLINE_DOWNLOADS =
  'Las descargas llegan completas, incrustadas en el resultado de la herramienta; no se pueden volver a leer después, así que guarda lo que necesites. Los datos de referencia (bancos, calendario SPEI, planes, estado de Banxico, enlaces a la documentación) están disponibles como recursos veriko://*.';

const TOOL_MENTION = /veriko_[a-z_]+/g;

/**
 * Quita de un texto las oraciones que nombran una herramienta que este servidor no ofrece, para que el modelo no
 * intente llamarla (con el perfil `core` no hay, por ejemplo, `veriko_recheck_validation`).
 *
 * Un párrafo que se queda sin oraciones desaparece.
 */
export function withoutMissingTools(text: string, available: ReadonlySet<string>): string {
  return text
    .split('\n\n')
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => (sentence.match(TOOL_MENTION) ?? []).every((name) => available.has(name)))
        .join(' '),
    )
    .filter((paragraph) => paragraph.trim() !== '')
    .join('\n\n');
}

/** Las instrucciones del servidor según cómo entrega las descargas y qué herramientas ofrece. */
export function serverInstructions(inline: boolean, available: ReadonlySet<string>): string {
  const text = inline
    ? SERVER_INSTRUCTIONS.split('\n\n')
        .map((paragraph) => (paragraph.startsWith('Las descargas llegan') ? INLINE_DOWNLOADS : paragraph))
        .join('\n\n')
    : SERVER_INSTRUCTIONS;

  return withoutMissingTools(text, available);
}

function annotations(tool: ToolDefinition): ToolAnnotations {
  return {
    readOnlyHint: tool.risk === 'read',
    destructiveHint: tool.destructive,
    idempotentHint: tool.idempotent,
    openWorldHint: tool.openWorld,
  };
}

function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Campos del CEP que no se repiten en el resultado: la cadena original y el sello digital traen otra vez los nombres,
 * RFC y cuentas de los dos lados, y son la prueba criptográfica que ya viene completa en `veriko_download_cep`.
 */
const CEP_PROOF_FIELDS = ['cadenaCda', 'digitalSignature'];

function withoutCepProof(value: unknown, depth = 0): unknown {
  if (depth > 6 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => withoutCepProof(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'banxico_result' && typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const result = { ...(item as Record<string, unknown>) };
      for (const field of CEP_PROOF_FIELDS) delete result[field];
      out[key] = result;
      continue;
    }
    out[key] = withoutCepProof(item, depth + 1);
  }
  return out;
}

/**
 * El resultado de una herramienta como objeto. Las claves de primer nivel que arma el SDK en camelCase (la página de
 * una lista, la respuesta de una validación asíncrona) salen en snake_case, como el resto de la API.
 */
function objectResult(value: unknown): Record<string, unknown> {
  if (value === undefined) return { ok: true };
  if (value === null) return { result: null };
  if (Array.isArray(value)) return { data: withoutCepProof(value) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key.startsWith('_') ? key : snakeCase(key)] = withoutCepProof(item);
    }
    return out;
  }
  return { result: value };
}

function jsonText(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[recortado a ${maxChars} caracteres; el resultado completo está en structuredContent. Acota los filtros o baja per_page/limit.]`;
}

interface Delivery {
  mode: 'store' | 'inline';
  store: ArtifactStore;
  inlineLimit: number;
  embedLimit: number;
  maxTextChars: number;
  notifyListChanged(): void;
}

/** Las formas de obtener un archivo más pequeño con esta herramienta, según los argumentos que acepta. */
function smallerFileHint(tool: ToolDefinition): string {
  const fields = new Set(Object.keys((tool.inputSchema as unknown as { shape?: object }).shape ?? {}));
  const options: string[] = [];
  if (fields.has('limit')) options.push('baja `limit` para exportar menos filas');
  if (fields.has('from') || fields.has('to')) options.push('acota `from` y `to`');
  if (fields.has('status') || fields.has('bank') || fields.has('banks')) options.push('agrega un filtro `status` o `bank`');
  const narrowing = options.length > 0 ? `${options.join(', ')}; o ` : '';
  const hint = `${narrowing}descárgalo con el paquete local por stdio, o directo desde la API con tu clave.`;
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
      message: `El archivo de ${size} bytes supera el límite de ${delivery.inlineLimit} bytes del modo HTTP.`,
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
        { type: 'text', text: `Se descargó ${summary}. Léelo en ${reference.uri} con resources/read.` },
      ],
      structuredContent,
    };
  }
  return {
    content: [
      { type: 'resource', resource: resourceContents(reference.uri, mimeType, file.content) },
      { type: 'text', text: `Se descargó ${summary}.` },
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
 * Envía `notifications/progress` de la petición en curso, cuando el cliente las
 * pidió con un `progressToken`. Una notificación fallida nunca hace fallar la llamada.
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
      // El cliente se fue o no recibe notificaciones: la llamada sigue.
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
  // Los archivos locales se leen sólo en modo stdio y sólo dentro de las raíces configuradas.
  const files: FileAccess | undefined =
    !inline && config.fileRoots && config.fileRoots.length > 0 ? { roots: config.fileRoots } : undefined;
  const tools = selectTools(config.profiles, config.maxRisk);
  const available = new Set(tools.map((tool) => tool.name));
  const server = new McpServer(
    {
      name: 'veriko-mcp-server',
      title: 'Veriko',
      version: MCP_VERSION,
      description: 'Verifica transferencias SPEI de México contra el CEP de Banxico.',
      websiteUrl: 'https://docs.veriko.mx/es/mcp',
    },
    { instructions: serverInstructions(inline, available) },
  );

  const delivery: Delivery = {
    mode: inline ? 'inline' : 'store',
    store: artifacts,
    inlineLimit: options.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES,
    embedLimit: options.maxEmbeddedArtifactBytes ?? DEFAULT_MAX_EMBEDDED_ARTIFACT_BYTES,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    notifyListChanged() {
      // Mejor esfuerzo: no hay sesión a la que avisar antes de que conecte el transporte.
      try {
        server.sendResourceListChanged();
      } catch {
        // Aún no hay conexión.
      }
    },
  };

  if (!inline) registerArtifactResources(server, artifacts);
  registerReferenceResources(server, client);
  registerPrompts(server, client);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: withoutMissingTools(tool.description, available),
        inputSchema: acceptingFormerNames(files && tool.localInputSchema ? tool.localInputSchema : tool.inputSchema),
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
            await runtime.progress?.({ progress: 0, total: 2, message: 'Pidiendo el archivo a Veriko' });
          }
          const value = await withCapture(captured, () => tool.invoke(client, args, runtime));
          if (isDownloadedFile(value)) {
            await runtime.progress?.({
              progress: 1,
              total: 2,
              message: `Se recibieron ${value.content.byteLength} bytes; preparando el resultado`,
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
