import type { Veriko } from '@veriko-mx/sdk-runtime';
import { WEBHOOK_EVENTS } from '@veriko-mx/sdk-runtime';

import { EXPORT_FORMAT_VALUES, VALIDATION_STATUSES } from './schemas.js';

/** El protocolo permite como máximo 100 valores en una respuesta de autocompletado. */
const MAX_VALUES = 100;
const BANKS_TTL_MS = 10 * 60 * 1000;

/** Valores que empiezan con lo que la persona escribió; todos cuando no ha escrito nada. */
export function startingWith(values: readonly string[], typed: string | undefined): string[] {
  const needle = (typed ?? '').trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().startsWith(needle)).slice(0, MAX_VALUES);
}

export const completeStatus = (typed: string | undefined): string[] => startingWith(VALIDATION_STATUSES, typed);
export const completeEvent = (typed: string | undefined): string[] => startingWith(WEBHOOK_EVENTS, typed);
export const completeFormat = (typed: string | undefined): string[] => startingWith(EXPORT_FORMAT_VALUES, typed);

/** Los años de los que se puede leer un calendario SPEI: el anterior, el actual y el siguiente. */
export function completeYear(typed: string | undefined, now: Date = new Date()): string[] {
  const year = now.getUTCFullYear();
  return startingWith([year - 1, year, year + 1].map(String), typed);
}

interface BankEntry {
  code: string;
  names: string[];
}

function entriesOf(banks: unknown): BankEntry[] {
  if (!Array.isArray(banks)) return [];
  const entries: BankEntry[] = [];
  for (const bank of banks as Array<Record<string, unknown>>) {
    const attributes = (bank.attributes ?? {}) as Record<string, unknown>;
    const code = typeof attributes.code === 'string' ? attributes.code : typeof bank.id === 'string' ? bank.id : undefined;
    if (!code) continue;
    const aliases = Array.isArray(attributes.aliases) ? (attributes.aliases as unknown[]) : [];
    const names = [attributes.name, ...aliases].filter((name): name is string => typeof name === 'string');
    entries.push({ code, names: names.map((name) => name.toLowerCase()) });
  }
  return entries;
}

/**
 * Completa códigos de banco SPEI desde el catálogo público de bancos. Un prefijo
 * de código o una parte del nombre o del alias encuentra el banco; la respuesta
 * siempre es el código. El catálogo se lee como máximo una vez cada diez minutos,
 * y una lectura fallida no da sugerencias en lugar de un error.
 */
export function bankCompleter(client: Veriko, now: () => number = () => Date.now()) {
  let cached: { at: number; entries: BankEntry[] } | undefined;
  return async (typed: string | undefined): Promise<string[]> => {
    if (!cached || now() - cached.at > BANKS_TTL_MS) {
      try {
        cached = { at: now(), entries: entriesOf(await client.catalog.banks()) };
      } catch {
        return [];
      }
    }
    const needle = (typed ?? '').trim().toLowerCase();
    return cached.entries
      .filter((bank) => bank.code.startsWith(needle) || (needle.length >= 2 && bank.names.some((name) => name.includes(needle))))
      .map((bank) => bank.code)
      .slice(0, MAX_VALUES);
  };
}
