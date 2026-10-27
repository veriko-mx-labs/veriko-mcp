import { createHash } from 'node:crypto';

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonicalize(value: unknown, key?: string): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (key === 'imageBase64' || key === 'fileBase64')) {
      const bytes = Buffer.from(value, 'base64');
      return { sha256: digest(bytes), size: bytes.byteLength };
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('La idempotencia no admite números no finitos.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    return { sha256: digest(value), size: value.byteLength };
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([entryKey, entryValue]) => entryKey !== 'idempotencyKey' && entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue, entryKey)]),
    );
  }
  throw new TypeError(`La idempotencia no admite valores ${typeof value}.`);
}

export function stableIdempotencyKey(
  operationId: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const explicit = args.idempotencyKey;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !IDEMPOTENCY_PATTERN.test(explicit)) {
      throw new TypeError('idempotencyKey debe usar sólo A-Z, a-z, 0-9, _ o - (1–255).');
    }
    return explicit;
  }

  const payload = JSON.stringify({ operationId, args: canonicalize(args) });
  return `veriko_mcp_v1_${digest(payload)}`;
}
