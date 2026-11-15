import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Verificación local de los tokens de acceso OAuth (RFC 9068) antes de leer el cuerpo de la petición.
 *
 * La API vuelve a verificar cada token (firma, vigencia, revocación), pero el servidor remoto no deja pasar un token
 * falso, vencido o emitido para otro recurso hasta el SDK: lo rechaza con `401` antes de construir nada. Revisa:
 *
 * - la cabecera: `typ: at+jwt`, `alg: ES256` y un `kid`;
 * - la firma, con la clave de ese `kid` publicada en el JWKS del servidor de autorización;
 * - `iss` igual al emisor del servidor de autorización;
 * - `aud` igual (exacto) al `resource` de los metadatos del recurso protegido (`https://api.veriko.mx/mcp`);
 * - `exp` en el futuro y `nbf` en el pasado, con una holgura corta para la diferencia de relojes.
 *
 * Todo sale por descubrimiento a partir de la URL de los metadatos del recurso (RFC 9728 → RFC 8414 → JWKS), así que
 * no hace falta ninguna variable nueva. Los documentos se guardan en memoria: los metadatos una hora y las claves cinco
 * minutos. Un `kid` desconocido vuelve a pedir el JWKS (a lo más una vez por minuto), para aceptar una clave recién
 * rotada sin abrir la puerta a forzar una consulta por petición. Las peticiones en paralelo comparten la consulta en
 * curso. Si una renovación falla, se siguen usando los documentos que ya había y no se reintenta antes de 10 segundos.
 * El `resource` de los metadatos debe ser el recurso del que sale su URL (RFC 9728 §3.3).
 */

/** Diferencia de relojes que se tolera en `exp` y `nbf`, en segundos. */
export const CLOCK_LEEWAY_SECONDS = 60;
const METADATA_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** Tras una consulta fallida, cuánto se espera antes de volver a intentarla. */
const FAILURE_BACKOFF_MS = 10_000;

export type AccessTokenCheck =
  | { ok: true }
  /** El token no vale: `401` con `error="invalid_token"`. */
  | { ok: false; kind: 'invalid'; reason: string }
  /** No se pudo obtener con qué verificar (red, documento roto): `503`, el cliente reintenta sin volver a autorizar. */
  | { ok: false; kind: 'unavailable'; reason: string };

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenCheck>;
}

export interface VerifierOptions {
  /** La URL de los metadatos del recurso protegido, la misma que anuncia el `401`. */
  resourceMetadataUrl: string;
  fetchImpl?: typeof fetch;
  /** Reloj en milisegundos; sólo para pruebas. */
  now?: () => number;
}

interface Discovery {
  issuer: string;
  resource: string;
  jwksUri: string;
  expiresAt: number;
}

interface KeySet {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

class UnavailableError extends Error {}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  return new URL(value).protocol === 'https:' ? value : undefined;
}

export function createAccessTokenVerifier(options: VerifierOptions): AccessTokenVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let discovery: Discovery | undefined;
  let keySet: KeySet | undefined;

  async function getJson(url: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch {
      throw new UnavailableError(`no se pudo leer ${url}`);
    }
    if (!response.ok) throw new UnavailableError(`${url} respondió ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UnavailableError(`${url} no devolvió JSON`);
    }
    if (!isRecord(body)) throw new UnavailableError(`${url} no devolvió un objeto`);
    return body;
  }

  let discoveryInFlight: Promise<Discovery> | undefined;
  let discoveryFailedAt: number | undefined;
  let keysInFlight: Promise<KeySet> | undefined;
  let keysFailedAt: number | undefined;

  /** RFC 9728 §3.1: la URL de los metadatos es la del recurso con `/.well-known/oauth-protected-resource` insertado. */
  function expectedResource(): string | undefined {
    if (!URL.canParse(options.resourceMetadataUrl)) return undefined;
    const url = new URL(options.resourceMetadataUrl);
    const marker = '/.well-known/oauth-protected-resource';
    if (!url.pathname.startsWith(marker)) return undefined;
    return `${url.origin}${url.pathname.slice(marker.length)}`;
  }

  async function fetchDiscovery(): Promise<Discovery> {
    const resourceDoc = await getJson(options.resourceMetadataUrl);
    const resource = httpsUrl(resourceDoc.resource);
    const servers = resourceDoc.authorization_servers;
    const issuer = Array.isArray(servers) ? httpsUrl(servers[0]) : undefined;
    if (!resource || !issuer) throw new UnavailableError('metadatos del recurso sin resource o authorization_servers');
    if (resource !== expectedResource()) throw new UnavailableError('el resource de los metadatos no es el de su URL');

    // RFC 8414 §3: el documento vive en /.well-known/oauth-authorization-server más la ruta del emisor, si tiene.
    const issuerUrl = new URL(issuer);
    const suffix = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
    const asDoc = await getJson(`${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`);
    const jwksUri = httpsUrl(asDoc.jwks_uri);
    if (asDoc.issuer !== issuer || !jwksUri) throw new UnavailableError('metadatos del servidor de autorización no coinciden');

    return { issuer, resource, jwksUri, expiresAt: now() + METADATA_TTL_MS };
  }

  async function discover(): Promise<Discovery> {
    if (discovery && discovery.expiresAt > now()) return discovery;
    if (discoveryFailedAt !== undefined && now() - discoveryFailedAt < FAILURE_BACKOFF_MS) {
      if (discovery) return discovery;
      throw new UnavailableError('descubrimiento fallido hace poco');
    }
    discoveryInFlight ??= fetchDiscovery()
      .then((found) => {
        discovery = found;
        discoveryFailedAt = undefined;
        return found;
      })
      .catch((error: unknown) => {
        discoveryFailedAt = now();
        if (discovery) return discovery;
        throw error;
      })
      .finally(() => {
        discoveryInFlight = undefined;
      });
    return discoveryInFlight;
  }

  async function fetchKeys(jwksUri: string): Promise<KeySet> {
    const doc = await getJson(jwksUri);
    const keys = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(doc.keys) ? doc.keys : []) {
      if (!isRecord(jwk) || typeof jwk.kid !== 'string') continue;
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
      if (jwk.alg !== undefined && jwk.alg !== 'ES256') continue;
      try {
        // Sólo la parte pública: `d` nunca debería venir en un JWKS, y si viene se descarta.
        keys.set(jwk.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as JsonWebKey, format: 'jwk' }));
      } catch {
        // Una clave rota no tumba a las demás.
      }
    }
    return { keys, fetchedAt: now() };
  }

  /** Renueva el JWKS. Si falla y ya había claves, las conserva; sin claves, el fallo sube como `unavailable`. */
  async function loadKeys(jwksUri: string): Promise<KeySet | undefined> {
    if (keysFailedAt !== undefined && now() - keysFailedAt < FAILURE_BACKOFF_MS) {
      if (keySet) return keySet;
      throw new UnavailableError('JWKS fallido hace poco');
    }
    keysInFlight ??= fetchKeys(jwksUri)
      .then((loaded) => {
        keySet = loaded;
        keysFailedAt = undefined;
        return loaded;
      })
      .catch((error: unknown) => {
        keysFailedAt = now();
        if (keySet) return keySet;
        throw error;
      })
      .finally(() => {
        keysInFlight = undefined;
      });
    return keysInFlight;
  }

  async function keyFor(jwksUri: string, kid: string): Promise<KeyObject | undefined> {
    if (!keySet || now() - keySet.fetchedAt > JWKS_TTL_MS) await loadKeys(jwksUri);
    let key = keySet?.keys.get(kid);
    if (!key && keySet && now() - keySet.fetchedAt > JWKS_MIN_REFRESH_MS) {
      key = (await loadKeys(jwksUri))?.keys.get(kid);
    }
    return key;
  }

  return {
    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, kind: 'invalid', reason: 'malformed' };
      const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
      let header: unknown;
      let payload: unknown;
      try {
        header = decodeSegment(encodedHeader);
        payload = decodeSegment(encodedPayload);
      } catch {
        return { ok: false, kind: 'invalid', reason: 'malformed' };
      }
      if (!isRecord(header) || !isRecord(payload)) return { ok: false, kind: 'invalid', reason: 'malformed' };
      if (header.typ !== 'at+jwt' || header.alg !== 'ES256' || typeof header.kid !== 'string') {
        return { ok: false, kind: 'invalid', reason: 'header' };
      }

      let found: Discovery;
      let key: KeyObject | undefined;
      try {
        found = await discover();
        key = await keyFor(found.jwksUri, header.kid);
      } catch (error) {
        return { ok: false, kind: 'unavailable', reason: error instanceof Error ? error.message : 'discovery' };
      }
      if (!key) return { ok: false, kind: 'invalid', reason: 'unknown_key' };

      const signature = Buffer.from(encodedSignature, 'base64url');
      const signed = verifySignature(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
      if (!signed) return { ok: false, kind: 'invalid', reason: 'signature' };

      if (payload.iss !== found.issuer) return { ok: false, kind: 'invalid', reason: 'issuer' };
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.some((aud) => aud === found.resource)) return { ok: false, kind: 'invalid', reason: 'audience' };

      const seconds = now() / 1000;
      if (typeof payload.exp !== 'number' || payload.exp + CLOCK_LEEWAY_SECONDS <= seconds) {
        return { ok: false, kind: 'invalid', reason: 'expired' };
      }
      if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_LEEWAY_SECONDS > seconds)) {
        return { ok: false, kind: 'invalid', reason: 'not_yet_valid' };
      }
      return { ok: true };
    },
  };
}
