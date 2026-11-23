import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NOT_EXPOSED_OPERATIONS, OPERATION_TOOLS } from '../src/catalog.js';
import { assertPublicM2MSurface } from './public-surface.js';
import { parse } from 'yaml';

const EXPECTED_PUBLIC_SPEC_SHA256 =
  '8105f89d0202f269665a2c93b89ef209ae1106067d08b63f42c9ed79fbc9e4b0';
/**
 * El contrato se lee de la copia versionada, como en los demás repositorios de
 * la organización.
 *
 * El workflow de sincronización lo trae del portal: llama al workflow
 * reutilizable de la organización, escribe aquí la exportación pública y abre un
 * PR cuando cambió. Ese PR queda en rojo a propósito, porque esta comprobación
 * compara contra un SHA-256 fijado a mano, y no se fusiona solo: un contrato
 * nuevo se revisa operación por operación antes de aceptarlo.
 *
 * Leer el portal en cada corrida haría que el resultado dependiera de lo que
 * estuviera desplegado en ese momento, sin nada registrado en el repositorio.
 *
 * `VERIKO_OPENAPI_URL` aún permite apuntar a una URL (el portal, un entorno de
 * pruebas) para revisar a mano lo que se está sirviendo.
 */
const override = process.env.VERIKO_OPENAPI_URL;
const versionedCopy = new URL('../spec/openapi.yaml', import.meta.url);

let body: string;
if (override) {
  const response = await fetch(override, {
    cache: 'no-store',
    headers: { accept: 'application/yaml, text/yaml' },
  });
  if (!response.ok) {
    throw new Error(`No se pudo leer ${override}: HTTP ${response.status}.`);
  }
  body = await response.text();
} else {
  body = readFileSync(versionedCopy, 'utf8');
}

const sha256 = createHash('sha256').update(body).digest('hex');
if (sha256 !== EXPECTED_PUBLIC_SPEC_SHA256) {
  throw new Error(
    `El contrato público cambió (${sha256}); revisa parámetros, cuerpos, respuestas y seguridad antes de actualizar EXPECTED_PUBLIC_SPEC_SHA256.`,
  );
}
/** Operaciones de la superficie pública M2M: 73 herramientas más las dos operaciones de purga que no se exponen. */
const PUBLIC_OPERATIONS = 75;
assertPublicM2MSurface(
  parse(body),
  OPERATION_TOOLS.map((tool) => tool.operationId),
  PUBLIC_OPERATIONS,
  NOT_EXPOSED_OPERATIONS,
);

process.stdout.write(
  `Superficie MCP alineada: ${PUBLIC_OPERATIONS} operaciones, ${OPERATION_TOOLS.length} con herramienta.\n`,
);
