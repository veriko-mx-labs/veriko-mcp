import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { loadConfig, type ServerConfig } from './config.js';
import { createVerikoServer, DEFAULT_MAX_INLINE_ARTIFACT_BYTES } from './server.js';

/** Igual que el búfer de stdio: cabe una importación máxima de 20 MB en base64. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 512;

export interface HttpOptions {
  /** Perfil, riesgo y URL base. La clave de API de este objeto se ignora. */
  config?: ServerConfig;
  /** Ruta del endpoint MCP. */
  path?: string;
  maxBodyBytes?: number;
  maxInlineArtifactBytes?: number;
  /** Si no está vacío, el encabezado Origin (cuando llega) debe estar en la lista. */
  allowedOrigins?: readonly string[];
  /** Sustituye el SDK de Veriko; sólo para pruebas. */
  clientFactory?: (apiKey: string) => Veriko;
  onerror?: (error: Error) => void;
}

export interface HttpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Extrae la clave del encabezado `Authorization: Bearer ...`. Devuelve
 * `undefined` si falta o tiene un formato inválido.
 */
export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  const token = match?.[1];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : undefined;
}

/**
 * Aplicación HTTP sin estado.
 *
 * Cada petición se autentica con la clave de API del integrador como Bearer,
 * construye su propio servidor MCP y su propio cliente del SDK.
 *
 * No deja nada en memoria al terminar: la clave no se guarda ni se registra.
 */
export function createHttpApp(options: HttpOptions = {}): HttpApp {
  // Nunca se hereda VERIKO_API_KEY del entorno: en HTTP la clave es de quien llama.
  const baseConfig: ServerConfig = {
    ...(options.config ?? loadConfig({ ...process.env, VERIKO_API_KEY: '' })),
    apiKey: '',
  };
  const path = options.path ?? '/mcp';
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  const handler = createMcpHandler(
    (ctx) => {
      const apiKey = ctx.authInfo?.token ?? '';
      return createVerikoServer({
        config: { ...baseConfig, apiKey },
        artifactMode: 'inline',
        maxInlineArtifactBytes: options.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES,
        ...(options.clientFactory ? { client: options.clientFactory(apiKey) } : {}),
      });
    },
    {
      maxRequestBodySize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ...(options.onerror ? { onerror: options.onerror } : {}),
    },
  );

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') return json(200, { status: 'ok' });
      if (url.pathname !== path) return json(404, { error: 'not_found' });

      const origin = request.headers.get('origin');
      if (allowedOrigins.size > 0 && origin !== null && !allowedOrigins.has(origin)) {
        return json(403, { error: 'origin_not_allowed' });
      }

      const token = bearerToken(request.headers.get('authorization'));
      if (!token) {
        return json(
          401,
          { error: 'unauthorized', message: 'Envía tu clave de API como Authorization: Bearer <clave>.' },
          { 'www-authenticate': 'Bearer realm="veriko-mcp"' },
        );
      }

      return handler.fetch(request, {
        authInfo: { token, clientId: 'veriko-api-key', scopes: [] },
      });
    },
    close: () => handler.close(),
  };
}

async function toWebRequest(req: IncomingMessage, host: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? host}`), {
    method,
    headers,
    ...(hasBody ? { body: req as unknown as BodyInit, duplex: 'half' } : {}),
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('close', () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export function startHttpServer(
  app: HttpApp,
  listen: { port: number; host: string },
): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await writeResponse(res, await app.fetch(await toWebRequest(req, listen.host)));
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}
