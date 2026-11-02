import { readFileSync } from 'node:fs';

import {
  McpServer,
  type CallToolResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { Veriko, type DownloadedFile } from '@veriko-mx/sdk-runtime';

import {
  ArtifactStore,
  describeArtifact,
  isDownloadedFile,
  registerArtifactResources,
} from './artifacts.js';
import { selectTools } from './catalog.js';
import { loadConfig, type ServerConfig } from './config.js';
import { safeError } from './errors.js';

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

const IDEMPOTENT_WRITES = new Set([
  'validateDirect',
  'validateOcr',
  'updateValidationRetryPolicy',
  'cancelValidationRetries',
  'updateMyRetryPolicy',
]);

export interface CreateServerOptions {
  config?: ServerConfig;
  client?: Veriko;
  artifacts?: ArtifactStore;
  /**
   * Cómo se entregan las descargas.
   *
   * `store` (stdio) guarda el archivo en la memoria del proceso y devuelve un
   * enlace `veriko://artifact/...`.
   *
   * `inline` (HTTP sin estado) lo incrusta en la respuesta, porque la
   * siguiente petición puede caer en otro proceso y el enlace ya no existiría.
   */
  artifactMode?: 'store' | 'inline';
  /** Tope en bytes de un archivo incrustado (sólo `inline`). */
  maxInlineArtifactBytes?: number;
}

export const DEFAULT_MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

function annotations(operationId: string, risk: 'read' | 'write' | 'destructive'): ToolAnnotations {
  return {
    readOnlyHint: risk === 'read',
    destructiveHint: risk === 'destructive',
    idempotentHint: risk === 'read' || IDEMPOTENT_WRITES.has(operationId),
    openWorldHint: true,
  };
}

function objectResult(value: unknown): Record<string, unknown> {
  if (value === undefined) return { ok: true };
  if (value === null) return { result: null };
  if (Array.isArray(value)) return { data: value };
  if (typeof value === 'object') return value as Record<string, unknown>;
  return { result: value };
}

function successResult(
  value: unknown,
  artifacts: ArtifactStore,
  inlineLimit: number | undefined,
): CallToolResult {
  if (isDownloadedFile(value)) {
    if (inlineLimit !== undefined) return inlineArtifactResult(value, inlineLimit);
    const artifact = artifacts.put(value);
    return {
      content: [
        {
          type: 'resource_link',
          uri: artifact.uri,
          name: artifact.name,
          mimeType: artifact.mimeType,
          description: `${artifact.size} bytes; sha256 ${artifact.sha256}`,
        },
      ],
      structuredContent: { artifact },
    };
  }

  const structuredContent = objectResult(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function inlineArtifactResult(file: DownloadedFile, limit: number): CallToolResult {
  const size = file.content.byteLength;
  if (size > limit) {
    const error = {
      code: 'artifact_too_large',
      message: `El archivo de ${size} bytes supera el límite de ${limit} bytes del modo HTTP. Descárgalo con el paquete local por stdio o directamente con la API.`,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }
  const reference = describeArtifact(file);
  return {
    content: [
      {
        type: 'resource',
        resource: {
          uri: `veriko://artifact/${reference.sha256.slice(0, 32)}`,
          mimeType: reference.mimeType,
          blob: Buffer.from(file.content).toString('base64'),
        },
      },
    ],
    structuredContent: { artifact: reference },
  };
}

function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: safe }) }],
    structuredContent: { error: safe },
  };
}

export function createVerikoServer(options: CreateServerOptions = {}): McpServer {
  const config = options.config ?? loadConfig();
  const client =
    options.client ??
    new Veriko({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      userAgentSuffix: `veriko-mcp/${MCP_VERSION}`,
    });
  const inline = options.artifactMode === 'inline';
  const inlineLimit = inline
    ? (options.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES)
    : undefined;
  const artifacts = options.artifacts ?? new ArtifactStore();
  const server = new McpServer(
    { name: 'veriko-mcp-server', version: MCP_VERSION },
    {
      instructions:
        'Usa las herramientas veriko_* para operar la API pública M2M. Las descargas regresan como recursos veriko://artifact/*: enlaces efímeros por stdio, o el archivo incrustado en la respuesta por HTTP. Conserva los identificadores entre llamadas y no inventes una clave de API.',
    },
  );

  if (!inline) registerArtifactResources(server, artifacts);

  for (const tool of selectTools(config.profiles, config.maxRisk)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotations(tool.operationId, tool.risk),
        _meta: {
          'veriko/operationId': tool.operationId,
          'veriko/family': tool.family,
          'veriko/risk': tool.risk,
          'veriko/cost': tool.cost,
        },
      },
      async (args) => {
        try {
          return successResult(await tool.invoke(client, args), artifacts, inlineLimit);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  return server;
}
