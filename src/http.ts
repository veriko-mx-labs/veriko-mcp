import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createMcpHandler, localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { loadConfig, type ServerConfig } from './config.js';
import { resolveOverrides } from './request-overrides.js';
import { createVerikoServer, DEFAULT_MAX_INLINE_ARTIFACT_BYTES } from './server.js';

/** Same as the stdio buffer: a maximum 20 MB import fits in base64. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 512;
/** The same shape the SDK requires: `veriko_` and 64 lowercase hexadecimal characters. */
const API_KEY_PATTERN = /^veriko_[0-9a-f]{64}$/;

export interface HttpOptions {
  /** Profile, risk and base URL. The API key in this object is ignored. */
  config?: ServerConfig;
  /** Path of the MCP endpoint. */
  path?: string;
  maxBodyBytes?: number;
  maxInlineArtifactBytes?: number;
  /**
   * Allowed browser origins (`https://app.example.com`). A request without
   * `Origin` (a non-browser client) passes; one with `Origin` passes only if it
   * is in the list. With an empty list every `Origin` is rejected.
   */
  allowedOrigins?: readonly string[];
  /**
   * Host names accepted in the `Host` header, without port (`mcp.example.com`,
   * `[::1]`). By default, only `localhost`, `127.0.0.1` and `[::1]`.
   */
  allowedHosts?: readonly string[];
  /** Replaces the Veriko SDK; for tests only. */
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
 * Extracts the key from the `Authorization: Bearer ...` header. Returns
 * `undefined` if it is missing or malformed.
 */
export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  const token = match?.[1];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : undefined;
}

/** Whether the value has the shape of a Veriko API key. It does not check that the key exists. */
export function isApiKeyShape(token: string): boolean {
  return API_KEY_PATTERN.test(token);
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Declared size of the body. `undefined` if there is no `Content-Length`;
 * `NaN` if the value is not a valid integer.
 */
function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get('content-length');
  if (raw === null) return undefined;
  return /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/**
 * Stateless HTTP application.
 *
 * Every request authenticates with the integrator API key as a Bearer token and
 * builds its own MCP server and its own SDK client.
 *
 * Nothing stays in memory afterwards: the key is neither stored nor logged.
 */
export function createHttpApp(options: HttpOptions = {}): HttpApp {
  // VERIKO_API_KEY is never inherited from the environment: over HTTP the key belongs to the caller.
  const baseConfig: ServerConfig = {
    ...(options.config ?? loadConfig({ ...process.env, VERIKO_API_KEY: '' })),
    apiKey: '',
  };
  const path = options.path ?? '/mcp';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = new Set<string>();
  for (const value of options.allowedOrigins ?? []) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error(`Invalid origin in the allowed list: ${value}`);
    allowedOrigins.add(origin);
  }
  const allowedHosts = (options.allowedHosts ?? localhostAllowedHostnames()).map(normalizeHostname);
  if (allowedHosts.length === 0) throw new Error('The list of allowed hosts cannot be empty.');

  const handler = createMcpHandler(
    (ctx) => {
      const apiKey = ctx.authInfo?.token ?? '';
      const overrides = ctx.requestInfo ? resolveOverrides(ctx.requestInfo.headers, baseConfig) : undefined;
      return createVerikoServer({
        config: { ...(overrides?.ok ? overrides.config : baseConfig), apiKey },
        ...(overrides?.ok && overrides.acceptLanguage ? { acceptLanguage: overrides.acceptLanguage } : {}),
        artifactMode: 'inline',
        maxInlineArtifactBytes: options.maxInlineArtifactBytes ?? DEFAULT_MAX_INLINE_ARTIFACT_BYTES,
        ...(options.clientFactory ? { client: options.clientFactory(apiKey) } : {}),
      });
    },
    {
      maxRequestBodySize: maxBodyBytes,
      ...(options.onerror ? { onerror: options.onerror } : {}),
    },
  );

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') return json(200, { status: 'ok' });
      if (url.pathname !== path) return json(404, { error: 'not_found' });

      // DNS rebinding protection: the Host must be one of ours.
      if (!validateHostHeader(request.headers.get('host'), allowedHosts).ok) {
        return json(403, { error: 'host_not_allowed' });
      }

      // A browser always sends Origin; only those in the list pass.
      const origin = request.headers.get('origin');
      if (origin !== null) {
        const normalized = normalizeOrigin(origin);
        if (!normalized || !allowedOrigins.has(normalized)) {
          return json(403, { error: 'origin_not_allowed' });
        }
      }

      // The shape of the key is checked before reading the body and before
      // initialize or tools/list, which never reach the API.
      const token = bearerToken(request.headers.get('authorization'));
      if (!token || !isApiKeyShape(token)) {
        return json(
          401,
          { error: 'unauthorized', message: 'Send your API key as Authorization: Bearer <key>.' },
          { 'www-authenticate': 'Bearer realm="veriko-mcp"' },
        );
      }

      // Per-request profile, risk and language; a header can only narrow the server's settings.
      const overrides = resolveOverrides(request.headers, baseConfig);
      if (!overrides.ok) return json(overrides.status, { error: overrides.error });

      // A body declared larger than the cap is rejected without reading it.
      // Without Content-Length (chunked), the handler cuts it at the cap.
      const length = declaredLength(request);
      if (length !== undefined && !(length <= maxBodyBytes)) {
        return json(Number.isNaN(length) ? 400 : 413, {
          error: Number.isNaN(length) ? 'invalid_content_length' : 'payload_too_large',
        });
      }

      return handler.fetch(request, {
        authInfo: { token, clientId: 'veriko-api-key', scopes: [] },
      });
    },
    close: () => handler.close(),
  };
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // The base URL is fixed: the client's Host is only validated, never interpreted here.
  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
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
        await writeResponse(res, await app.fetch(await toWebRequest(req)));
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    })();
  });
  // Cuts slow clients: headers within 30 s and the whole request within 2 min.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}
