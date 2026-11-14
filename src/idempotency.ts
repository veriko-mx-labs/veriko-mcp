import { randomUUID } from 'node:crypto';

export const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * La clave de una llamada a una herramienta.
 *
 * Sin clave de quien llama, la llamada recibe una clave aleatoria nueva, así que
 * repetir los mismos argumentos siempre es un intento nuevo: una validación que
 * se vuelve a ejecutar después de un `not_found` consulta a Banxico otra vez, y
 * una política de reintentos que vuelve a un valor anterior se aplica de nuevo.
 * Para que un reintento sea seguro tras una respuesta perdida, quien llama envía
 * la misma `idempotency_key` de la primera vez; la API repite entonces la
 * respuesta guardada durante 24 horas y devuelve `Idempotent-Replayed: true`.
 */
export function resolveIdempotencyKey(provided: unknown): string {
  if (provided !== undefined) {
    if (typeof provided !== 'string' || !IDEMPOTENCY_PATTERN.test(provided)) {
      throw new TypeError('idempotency_key sólo puede usar A-Z, a-z, 0-9, _ y - (de 1 a 255 caracteres).');
    }
    return provided;
  }
  return `veriko_mcp_${randomUUID()}`;
}
