import {
  McpServer,
  type CallToolResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { Veriko } from '@veriko-mx/sdk-runtime';

import {
  ArtifactStore,
  isDownloadedFile,
  registerArtifactResources,
} from './artifacts.js';
import { selectTools } from './catalog.js';
import { loadConfig, type ServerConfig } from './config.js';
import { safeError } from './errors.js';

export const MCP_VERSION = '0.1.1';

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
}

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

function successResult(value: unknown, artifacts: ArtifactStore): CallToolResult {
  if (isDownloadedFile(value)) {
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
  const artifacts = options.artifacts ?? new ArtifactStore();
  const server = new McpServer(
    { name: 'veriko-mcp-server', version: MCP_VERSION },
    {
      instructions:
        'Usa las herramientas veriko_* para operar la API pública M2M. Las descargas regresan enlaces a recursos efímeros veriko://artifact/*. Conserva los identificadores entre llamadas y no inventes una clave de API.',
    },
  );

  registerArtifactResources(server, artifacts);

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
          return successResult(await tool.invoke(client, args), artifacts);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  return server;
}
