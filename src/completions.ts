import type { Veriko } from '@veriko-mx/sdk-runtime';
import { WEBHOOK_EVENTS } from '@veriko-mx/sdk-runtime';

import { EXPORT_FORMAT_VALUES, VALIDATION_STATUSES } from './schemas.js';

/** The protocol allows at most 100 values in one completion answer. */
const MAX_VALUES = 100;
const BANKS_TTL_MS = 10 * 60 * 1000;

/** Values that start with what the person typed; all of them when nothing is typed. */
export function startingWith(values: readonly string[], typed: string | undefined): string[] {
  const needle = (typed ?? '').trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().startsWith(needle)).slice(0, MAX_VALUES);
}

export const completeStatus = (typed: string | undefined): string[] => startingWith(VALIDATION_STATUSES, typed);
export const completeEvent = (typed: string | undefined): string[] => startingWith(WEBHOOK_EVENTS, typed);
export const completeFormat = (typed: string | undefined): string[] => startingWith(EXPORT_FORMAT_VALUES, typed);

/** The years a SPEI calendar can be read for: the previous one, this one and the next. */
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
 * Completes SPEI bank codes from the public bank catalog. A code prefix or a
 * part of a name or alias finds the bank; the answer is always the code. The
 * catalog is read at most once every ten minutes, and a failed read gives no
 * suggestions instead of an error.
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
