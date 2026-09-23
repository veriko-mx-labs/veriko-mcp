import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { TOOL_CATALOG } from '../src/catalog.js';
import { assertPublicM2MSurface } from './public-surface.js';
import { parse } from 'yaml';

const EXPECTED_PUBLIC_SPEC_SHA256 =
  '4b5f1b6e5cb9ff9aa7ac0c325785730cd29d09d28abaf899a4c052d5d5dbc62f';
/**
 * El contrato se lee de la copia versionada, como en los demás repositorios de la
 * organización.
 *
 * Quien la trae del portal es el workflow de sincronización, que invoca el
 * reusable de la organización: descarga el export público, lo escribe aquí y
 * abre un PR si cambió. Ese PR nace rojo a propósito, porque esta comprobación
 * compara contra un SHA-256 fijado a mano, y no se auto-mergea: un contrato nuevo
 * se revisa operación por operación antes de aceptarlo.
 *
 * Leer el portal en cada corrida haría que el resultado dependiera de lo que
 * hubiera desplegado en ese momento, sin que nada quedara registrado en el
 * repositorio.
 *
 * `VERIKO_OPENAPI_URL` sigue permitiendo apuntar a una URL —el portal, un
 * entorno de pruebas— para comprobar a mano qué se está sirviendo.
 */
const override = process.env.VERIKO_OPENAPI_URL;
const copiaVersionada = new URL('../spec/openapi.yaml', import.meta.url);

let body: string;
if (override) {
  const response = await fetch(override, {
    cache: 'no-store',
    headers: { accept: 'application/yaml, text/yaml' },
  });
  if (!response.ok) {
    throw new Error(`No fue posible leer ${override}: HTTP ${response.status}.`);
  }
  body = await response.text();
} else {
  body = readFileSync(copiaVersionada, 'utf8');
}

const sha256 = createHash('sha256').update(body).digest('hex');
if (sha256 !== EXPECTED_PUBLIC_SPEC_SHA256) {
  throw new Error(
    `El contrato público cambió (${sha256}); revisa parámetros, cuerpos, respuestas y seguridad antes de actualizar EXPECTED_PUBLIC_SPEC_SHA256.`,
  );
}
assertPublicM2MSurface(
  parse(body),
  TOOL_CATALOG.map((tool) => tool.operationId),
);

process.stdout.write('Superficie MCP alineada: 66 operaciones.\n');
