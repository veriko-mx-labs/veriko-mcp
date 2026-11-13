import { open, realpath } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, relative } from 'node:path';

/** The same limits the API applies: a receipt image up to 12 MB, an import file up to 20 MB. */
export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024;
export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

/** What a tool may read from the local disk. Present only in stdio mode, with roots set. */
export interface FileAccess {
  /** Absolute directories. A file is readable only inside one of them. */
  roots: readonly string[];
}

/** A file path the server refuses to read. The message says why, without naming other files. */
export class FileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileInputError';
  }
}

/** Reads `VERIKO_MCP_FILE_ROOTS`: absolute directories separated by the platform path delimiter. */
export function parseFileRoots(raw: string | undefined): string[] {
  const roots = (raw ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new Error(`VERIKO_MCP_FILE_ROOTS accepts absolute directories only; received ${root}.`);
    }
  }
  return roots;
}

export interface FileRules {
  /** Name of the argument, for the messages. */
  label: string;
  maxBytes: number;
  /** Accepts the file when this returns `undefined`; otherwise the reason it is refused. */
  check(file: { name: string; bytes: Uint8Array }): string | undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** A receipt is a JPEG, PNG, WebP or PDF: the leading bytes decide, not the name. */
export const RECEIPT_RULES: FileRules = {
  label: 'image_path',
  maxBytes: MAX_RECEIPT_BYTES,
  check: ({ bytes }) =>
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) ||
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
      ? undefined
      : 'The file is not a JPEG, PNG, WebP or PDF.',
};

const IMPORT_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx', '.txt', '.json', '.pdf']);

export const IMPORT_RULES: FileRules = {
  label: 'file_path',
  maxBytes: MAX_IMPORT_FILE_BYTES,
  check: ({ name }) =>
    IMPORT_EXTENSIONS.has(extname(name).toLowerCase())
      ? undefined
      : 'The file extension must be .csv, .xls, .xlsx, .txt, .json or .pdf.',
};

function inside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== '' && !difference.startsWith('..') && !isAbsolute(difference);
}

/**
 * Reads one file the person pointed at.
 *
 * The path must be absolute and, once symbolic links are resolved, inside one
 * of the configured roots; it must be a regular file within the size limit.
 * The size is checked on the open file, so a file that grows after the check
 * is still cut off.
 */
export async function readLocalFile(
  path: string,
  access: FileAccess | undefined,
  rules: FileRules,
): Promise<{ bytes: Buffer; filename: string }> {
  if (!access || access.roots.length === 0) {
    throw new FileInputError(`${rules.label} is not available: this server has no VERIKO_MCP_FILE_ROOTS.`);
  }
  if (!isAbsolute(path)) {
    throw new FileInputError(`${rules.label} must be an absolute path.`);
  }

  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new FileInputError(`${rules.label} does not name a readable file.`);
  }
  const roots = await Promise.all(access.roots.map((root) => realpath(root).catch(() => undefined)));
  if (!roots.some((root) => root !== undefined && inside(root, resolved))) {
    throw new FileInputError(`${rules.label} is outside the directories in VERIKO_MCP_FILE_ROOTS.`);
  }

  const handle = await open(resolved, 'r').catch(() => {
    throw new FileInputError(`${rules.label} does not name a readable file.`);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new FileInputError(`${rules.label} must name a regular file.`);
    if (stats.size > rules.maxBytes) {
      throw new FileInputError(`The file exceeds the ${rules.maxBytes / (1024 * 1024)} MB limit.`);
    }
    if (stats.size === 0) throw new FileInputError('The file is empty.');
    const bytes = Buffer.alloc(Math.min(stats.size, rules.maxBytes) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > rules.maxBytes) {
      throw new FileInputError(`The file exceeds the ${rules.maxBytes / (1024 * 1024)} MB limit.`);
    }
    const content = bytes.subarray(0, bytesRead);
    const name = basename(resolved);
    const refusal = rules.check({ name, bytes: content });
    if (refusal) throw new FileInputError(refusal);
    return { bytes: content, filename: name };
  } finally {
    await handle.close();
  }
}
