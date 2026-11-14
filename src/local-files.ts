import { open, realpath } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, relative } from 'node:path';

/** Los mismos límites que aplica la API: una imagen de comprobante de hasta 12 MB y un archivo de importación de hasta 20 MB. */
export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024;
export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

/** Lo que una herramienta puede leer del disco local. Sólo existe en modo stdio, con raíces configuradas. */
export interface FileAccess {
  /** Directorios absolutos. Un archivo se puede leer sólo dentro de alguno de ellos. */
  roots: readonly string[];
}

/** Una ruta de archivo que el servidor se niega a leer. El mensaje dice por qué, sin nombrar otros archivos. */
export class FileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileInputError';
  }
}

/** Lee `VERIKO_MCP_FILE_ROOTS`: directorios absolutos separados por el delimitador de rutas de la plataforma. */
export function parseFileRoots(raw: string | undefined): string[] {
  const roots = (raw ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new Error(`VERIKO_MCP_FILE_ROOTS acepta sólo directorios absolutos; se recibió ${root}.`);
    }
  }
  return roots;
}

export interface FileRules {
  /** Nombre del argumento, para los mensajes. */
  label: string;
  maxBytes: number;
  /** Acepta el archivo cuando devuelve `undefined`; si no, devuelve el motivo del rechazo. */
  check(file: { name: string; bytes: Uint8Array }): string | undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Un comprobante es un JPEG, PNG, WebP o PDF: deciden los primeros bytes, no el nombre. */
export const RECEIPT_RULES: FileRules = {
  label: 'image_path',
  maxBytes: MAX_RECEIPT_BYTES,
  check: ({ bytes }) =>
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) ||
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
      ? undefined
      : 'El archivo no es un JPEG, PNG, WebP ni PDF.',
};

const IMPORT_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx', '.txt', '.json', '.pdf']);

export const IMPORT_RULES: FileRules = {
  label: 'file_path',
  maxBytes: MAX_IMPORT_FILE_BYTES,
  check: ({ name }) =>
    IMPORT_EXTENSIONS.has(extname(name).toLowerCase())
      ? undefined
      : 'La extensión del archivo debe ser .csv, .xls, .xlsx, .txt, .json o .pdf.',
};

function inside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== '' && !difference.startsWith('..') && !isAbsolute(difference);
}

/**
 * Lee un archivo que la persona señaló.
 *
 * La ruta debe ser absoluta y, una vez resueltos los enlaces simbólicos, estar
 * dentro de una de las raíces configuradas; debe ser un archivo regular dentro
 * del límite de tamaño. El tamaño se comprueba sobre el archivo abierto, así
 * que un archivo que crece después de la comprobación igual se corta.
 */
export async function readLocalFile(
  path: string,
  access: FileAccess | undefined,
  rules: FileRules,
): Promise<{ bytes: Buffer; filename: string }> {
  if (!access || access.roots.length === 0) {
    throw new FileInputError(`${rules.label} no está disponible: este servidor no tiene VERIKO_MCP_FILE_ROOTS.`);
  }
  if (!isAbsolute(path)) {
    throw new FileInputError(`${rules.label} debe ser una ruta absoluta.`);
  }

  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new FileInputError(`${rules.label} no apunta a un archivo legible.`);
  }
  const roots = await Promise.all(access.roots.map((root) => realpath(root).catch(() => undefined)));
  if (!roots.some((root) => root !== undefined && inside(root, resolved))) {
    throw new FileInputError(`${rules.label} está fuera de los directorios de VERIKO_MCP_FILE_ROOTS.`);
  }

  const handle = await open(resolved, 'r').catch(() => {
    throw new FileInputError(`${rules.label} no apunta a un archivo legible.`);
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new FileInputError(`${rules.label} debe apuntar a un archivo regular.`);
    if (stats.size > rules.maxBytes) {
      throw new FileInputError(`El archivo supera el límite de ${rules.maxBytes / (1024 * 1024)} MB.`);
    }
    if (stats.size === 0) throw new FileInputError('El archivo está vacío.');
    const bytes = Buffer.alloc(Math.min(stats.size, rules.maxBytes) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > rules.maxBytes) {
      throw new FileInputError(`El archivo supera el límite de ${rules.maxBytes / (1024 * 1024)} MB.`);
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
