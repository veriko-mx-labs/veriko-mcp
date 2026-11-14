import { FAMILIES, riskAllowed, type Profile, type Risk, type ServerConfig } from './config.js';

const RISKS: readonly Risk[] = ['read', 'write', 'destructive'];
const PROFILES: ReadonlySet<string> = new Set(['core', 'all', ...FAMILIES]);

export type Language = 'en' | 'es';

export type Overrides =
  | { ok: true; config: ServerConfig; acceptLanguage?: Language }
  | { ok: false; status: 400 | 403; error: string };

/** El idioma que prefiere quien llama entre los dos en los que responde la API, o ninguno. */
export function languageFrom(header: string | null): Language | undefined {
  const ranked = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      const q = parameters.map((item) => /^\s*q=([\d.]+)\s*$/i.exec(item)?.[1]).find(Boolean);
      return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', q: q === undefined ? 1 : Number(q) };
    })
    .filter((entry) => entry.q > 0 && (entry.primary === 'en' || entry.primary === 'es'))
    .sort((a, b) => b.q - a.q);
  return ranked[0]?.primary as Language | undefined;
}

/**
 * La configuración con la que corre una petición HTTP.
 *
 * `X-Veriko-Profile` y `X-Veriko-Max-Risk` sólo pueden acotar lo que el servidor
 * permite: un perfil que el servidor no anuncia, o un riesgo mayor, responde 403.
 * `Accept-Language` elige el idioma del detalle de los errores de la API.
 */
export function resolveOverrides(headers: Headers, base: ServerConfig): Overrides {
  let config = base;

  const profile = headers.get('x-veriko-profile')?.trim();
  if (profile) {
    const requested = profile.split(',').map((value) => value.trim()).filter(Boolean);
    if (requested.length === 0 || requested.some((value) => !PROFILES.has(value))) {
      return { ok: false, status: 400, error: 'invalid_profile_header' };
    }
    if (!base.profiles.has('all') && requested.some((value) => !base.profiles.has(value as Profile))) {
      return { ok: false, status: 403, error: 'profile_not_allowed' };
    }
    config = { ...config, profiles: new Set(requested as Profile[]) };
  }

  const risk = headers.get('x-veriko-max-risk')?.trim();
  if (risk) {
    if (!RISKS.includes(risk as Risk)) return { ok: false, status: 400, error: 'invalid_max_risk_header' };
    if (!riskAllowed(risk as Risk, base.maxRisk)) return { ok: false, status: 403, error: 'max_risk_not_allowed' };
    config = { ...config, maxRisk: risk as Risk };
  }

  const acceptLanguage = languageFrom(headers.get('accept-language'));
  return { ok: true, config, ...(acceptLanguage ? { acceptLanguage } : {}) };
}
