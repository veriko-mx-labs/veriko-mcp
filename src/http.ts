import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createMcpHandler, localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { isAccessTokenShape, MAX_ACCESS_TOKEN_LENGTH } from './client.js';
import { loadConfig, type ServerConfig } from './config.js';
import { resolveOverrides } from './request-overrides.js';
import { createVerikoServer, DEFAULT_MAX_INLINE_ARTIFACT_BYTES } from './server.js';

/** Igual que el búfer de stdio: una importación de 20 MB como máximo cabe en base64. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** La misma forma que exige el SDK: `veriko_` y 64 caracteres hexadecimales en minúscula. */
const API_KEY_PATTERN = /^veriko_[0-9a-f]{64}$/;

export interface HttpOptions {
  /** Perfil, riesgo y URL base. La clave de API de este objeto se ignora. */
  config?: ServerConfig;
  /** Ruta del endpoint MCP. */
  path?: string;
  maxBodyBytes?: number;
  maxInlineArtifactBytes?: number;
  /**
   * Orígenes de navegador permitidos (`https://app.example.com`). Una petición sin
   * `Origin` (un cliente que no es navegador) pasa; una con `Origin` pasa sólo si
   * está en la lista. Con la lista vacía se rechaza todo `Origin`.
   */
  allowedOrigins?: readonly string[];
  /**
   * Nombres de host aceptados en el encabezado `Host`, sin puerto (`mcp.example.com`,
   * `[::1]`). Por omisión, sólo `localhost`, `127.0.0.1` y `[::1]`.
   */
  allowedHosts?: readonly string[];
  /**
   * URL pública de los metadatos del recurso protegido (RFC 9728), por ejemplo
   * `https://api.example.com/.well-known/oauth-protected-resource/mcp`. Si se indica, el `401` la anuncia en
   * `WWW-Authenticate` para que un cliente MCP descubra el servidor de autorización y conecte con OAuth.
   */
  resourceMetadataUrl?: string;
  /** Reemplaza al SDK de Veriko; sólo para pruebas. */
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
 * `undefined` si falta o está mal formado.
 */
export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  const token = match?.[1];
  return token && token.length <= MAX_ACCESS_TOKEN_LENGTH ? token : undefined;
}

/** Si el valor tiene la forma de una clave de API de Veriko. No comprueba que la clave exista. */
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
 * Tamaño declarado del cuerpo. `undefined` si no hay `Content-Length`;
 * `NaN` si el valor no es un entero válido.
 */
function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get('content-length');
  if (raw === null) return undefined;
  return /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/**
 * Aplicación HTTP sin estado.
 *
 * Cada petición se autentica con la clave de API del integrador o con un token de acceso OAuth como token Bearer
 * y construye su propio servidor MCP y su propio cliente del SDK.
 *
 * Después no queda nada en memoria: la clave no se guarda ni se registra.
 */
export function createHttpApp(options: HttpOptions = {}): HttpApp {
  // VERIKO_API_KEY nunca se hereda del entorno: por HTTP la clave es de quien llama.
  const baseConfig: ServerConfig = {
    ...(options.config ?? loadConfig({ ...process.env, VERIKO_API_KEY: '' })),
    apiKey: '',
  };
  const path = options.path ?? '/mcp';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = new Set<string>();
  for (const value of options.allowedOrigins ?? []) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error(`Origen no válido en la lista de permitidos: ${value}`);
    allowedOrigins.add(origin);
  }
  const resourceMetadataUrl = options.resourceMetadataUrl?.trim();
  if (resourceMetadataUrl !== undefined && resourceMetadataUrl !== '') {
    const parsed = URL.canParse(resourceMetadataUrl) ? new URL(resourceMetadataUrl) : undefined;
    if (!parsed || parsed.protocol !== 'https:' || /["\\]/.test(resourceMetadataUrl)) {
      throw new Error(`URL de metadatos del recurso no válida: ${resourceMetadataUrl}`);
    }
  }
  const challenge = resourceMetadataUrl
    ? `Bearer realm="veriko-mcp", resource_metadata="${resourceMetadataUrl}"`
    : 'Bearer realm="veriko-mcp"';
  const allowedHosts = (options.allowedHosts ?? localhostAllowedHostnames()).map(normalizeHostname);
  if (allowedHosts.length === 0) throw new Error('La lista de hosts permitidos no puede estar vacía.');

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

      // Protección contra DNS rebinding: el Host debe ser uno de los nuestros.
      if (!validateHostHeader(request.headers.get('host'), allowedHosts).ok) {
        return json(403, { error: 'host_not_allowed' });
      }

      // Un navegador siempre envía Origin; sólo pasan los que están en la lista.
      const origin = request.headers.get('origin');
      if (origin !== null) {
        const normalized = normalizeOrigin(origin);
        if (!normalized || !allowedOrigins.has(normalized)) {
          return json(403, { error: 'origin_not_allowed' });
        }
      }

      // La forma de la clave o del token se revisa antes de leer el cuerpo y antes de
      // initialize o tools/list, que nunca llegan a la API.
      const token = bearerToken(request.headers.get('authorization'));
      const oauth = token !== undefined && isAccessTokenShape(token);
      if (!token || !(oauth || isApiKeyShape(token))) {
        return json(
          401,
          {
            error: 'unauthorized',
            message: 'Envía tu clave de API o un token de acceso OAuth como Authorization: Bearer <token>.',
          },
          { 'www-authenticate': challenge },
        );
      }

      // Perfil, riesgo e idioma por petición; un encabezado sólo puede acotar lo que el servidor ya permite.
      const overrides = resolveOverrides(request.headers, baseConfig);
      if (!overrides.ok) return json(overrides.status, { error: overrides.error });

      // Un cuerpo declarado mayor que el tope se rechaza sin leerlo.
      // Sin Content-Length (chunked), el manejador lo corta en el tope.
      const length = declaredLength(request);
      if (length !== undefined && !(length <= maxBodyBytes)) {
        return json(Number.isNaN(length) ? 400 : 413, {
          error: Number.isNaN(length) ? 'invalid_content_length' : 'payload_too_large',
        });
      }

      return handler.fetch(request, {
        authInfo: { token, clientId: oauth ? 'veriko-oauth' : 'veriko-api-key', scopes: [] },
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
  // La URL base es fija: el Host del cliente sólo se valida, aquí nunca se interpreta.
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
  // Corta a los clientes lentos: encabezados en 30 s y la petición completa en 2 min.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}
