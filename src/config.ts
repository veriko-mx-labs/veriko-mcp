import { parseFileRoots } from './local-files.js';

export const FAMILIES = [
  'validations',
  'webhooks',
  'catalog',
  'beneficiaries',
  'usage',
  'account',
  'dashboard',
  'plans',
  'insights',
  'finance',
  'billing',
] as const;

export type Family = (typeof FAMILIES)[number];
export type Risk = 'read' | 'write' | 'destructive';
export type Profile = 'core' | 'all' | Family;

const RISKS: readonly Risk[] = ['read', 'write', 'destructive'];

export interface ServerConfig {
  apiKey: string;
  baseUrl?: string;
  profiles: ReadonlySet<Profile>;
  maxRisk: Risk;
  /**
   * Directories a tool may read receipts and import files from (`image_path`,
   * `file_path`). Stdio only: the HTTP server never reads the local disk.
   */
  fileRoots?: readonly string[];
}

function parseProfiles(raw: string | undefined): ReadonlySet<Profile> {
  const values = (raw?.trim() || 'core')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set<string>(['core', 'all', ...FAMILIES]);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new Error(`VERIKO_MCP_PROFILE contains unknown profiles: ${invalid.join(', ')}`);
  }
  return new Set(values as Profile[]);
}

function parseRisk(raw: string | undefined): Risk {
  const value = raw?.trim() || 'write';
  if (!RISKS.includes(value as Risk)) {
    throw new Error(`VERIKO_MCP_MAX_RISK must be read, write or destructive; received ${value}.`);
  }
  return value as Risk;
}

function parseBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VERIKO_BASE_URL must be an absolute URL.');
  }
  if (url.username || url.password) {
    throw new Error('VERIKO_BASE_URL does not accept embedded credentials.');
  }

  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('VERIKO_BASE_URL must use HTTPS; HTTP is accepted only for localhost.');
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const baseUrl = parseBaseUrl(env.VERIKO_BASE_URL);
  const fileRoots = parseFileRoots(env.VERIKO_MCP_FILE_ROOTS);
  return {
    apiKey: env.VERIKO_API_KEY?.trim() ?? '',
    ...(baseUrl ? { baseUrl } : {}),
    profiles: parseProfiles(env.VERIKO_MCP_PROFILE),
    maxRisk: parseRisk(env.VERIKO_MCP_MAX_RISK),
    ...(fileRoots.length > 0 ? { fileRoots } : {}),
  };
}

export function riskAllowed(risk: Risk, maximum: Risk): boolean {
  return RISKS.indexOf(risk) <= RISKS.indexOf(maximum);
}
