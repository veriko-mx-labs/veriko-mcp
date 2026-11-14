import { RequestAbortedError } from '@veriko-mx/sdk-runtime';

/** El error con el que termina una llamada cuando el cliente MCP cancela la petición a la que pertenece. */
export function abortedError(signal: AbortSignal): RequestAbortedError {
  return new RequestAbortedError('El cliente canceló la petición.', { cause: signal.reason });
}
