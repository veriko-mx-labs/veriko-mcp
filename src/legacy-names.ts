/**
 * Argument names accepted from clients written against earlier releases.
 *
 * They are translated before validation and never appear in a schema, a description or the
 * documentation: the advertised input schema stays the one built from `src/schemas.ts`.
 * A name is only translated when the tool accepts its replacement and does not accept the
 * name itself, and the current name wins when a client sends both.
 */
const RENAMED: Readonly<Record<string, string>> = {
  fecha: 'send_date',
  monto: 'amount',
  claveRastreo: 'tracking_key',
  referenciaNumerica: 'numeric_reference',
  cuentaBeneficiaria: 'beneficiary_account',
  cuentasCandidatas: 'candidate_accounts',
  emisor: 'sender_bank',
  receptor: 'receiver_bank',
  bancoEmisor: 'sender_bank',
  bancoReceptor: 'receiver_bank',
  receptorParticipante: 'recipient_is_bank',
  policy: 'retry_policy',
  endpointIds: 'endpoint_id',
};

/** Arguments whose former value had another type. */
const CONVERT: Readonly<Record<string, (value: unknown) => unknown>> = {
  with_deleted: toFlag,
  with_archived: toFlag,
  recipient_is_bank: (value) => (value === 0 || value === 1 ? value === 1 : value),
};

/** Never translated: these arguments were removed on purpose. */
const WITHHELD = new Set(['userId']);

function toFlag(value: unknown): unknown {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rewrites former argument names to the current ones for a tool that accepts `fields`. */
export function translateFormerNames(args: unknown, fields: ReadonlySet<string>): unknown {
  if (!isPlainObject(args)) return args;
  const out: Record<string, unknown> = {};
  const moved: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(args)) {
    if (fields.has(name) || WITHHELD.has(name)) {
      out[name] = value;
      continue;
    }
    const target = RENAMED[name] ?? snakeCase(name);
    if (target !== name && fields.has(target)) moved.push([target, value]);
    else out[name] = value;
  }
  for (const [target, value] of moved) {
    if (target in out) continue;
    const convert = CONVERT[target];
    out[target] = convert ? convert(value) : value;
  }
  return out;
}

interface ShapedSchema {
  readonly '~standard': { validate(value: unknown): unknown };
  readonly shape?: Record<string, unknown>;
}

/**
 * Wraps an object schema so validation first translates former argument names. The JSON
 * Schema it advertises is the wrapped schema's own, unchanged.
 */
export function acceptingFormerNames<S extends ShapedSchema>(schema: S): S {
  const fields = new Set(Object.keys(schema.shape ?? {}));
  if (fields.size === 0) return schema;
  const standard = schema['~standard'];
  const wrapped = {
    '~standard': {
      ...standard,
      validate: (value: unknown) => standard.validate(translateFormerNames(value, fields)),
    },
  };
  return wrapped as unknown as S;
}
