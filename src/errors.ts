import {
  ApiError,
  ConfigurationError,
  ConnectionError,
  RateLimitError,
  TimeoutError,
  VerikoError,
} from '@veriko-mx/sdk-runtime';

import { ArtifactLimitError } from './artifacts.js';

export interface SafeError {
  type: string;
  code: string;
  message: string;
  status?: number;
  pointer?: string;
  requestId?: string;
  retryAfter?: number;
  resourceId?: string;
  timeoutMs?: number;
  attempts?: number;
  size?: number;
  limit?: number;
}

export function safeError(error: unknown): SafeError {
  if (error instanceof ApiError) {
    return {
      type: error.name,
      code: error.code ?? `http_${error.status}`,
      message: `Veriko rechazó la operación con ${error.code ?? `HTTP ${error.status}`}.`,
      status: error.status,
      ...(error.pointer ? { pointer: error.pointer } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error instanceof RateLimitError && error.retryAfter !== undefined
        ? { retryAfter: error.retryAfter }
        : {}),
    };
  }
  if (error instanceof TimeoutError) {
    return {
      type: error.name,
      code: 'timeout',
      message: 'La espera terminó antes de que el recurso alcanzara un estado firme.',
      resourceId: error.resourceId,
      timeoutMs: error.timeoutMs,
    };
  }
  if (error instanceof ConfigurationError) {
    return {
      type: error.name,
      code: 'configuration_error',
      message: 'La operación requiere una configuración válida; verifica VERIKO_API_KEY y los argumentos.',
    };
  }
  if (error instanceof ConnectionError) {
    return {
      type: error.name,
      code: 'connection_error',
      message: 'No fue posible conectar con Veriko después de los reintentos configurados.',
      attempts: error.attempts,
    };
  }
  if (error instanceof ArtifactLimitError) {
    return {
      type: error.name,
      code: 'artifact_too_large',
      message: 'El archivo excede el límite de recursos efímeros del servidor MCP.',
      size: error.size,
      limit: error.limit,
    };
  }
  if (error instanceof VerikoError) {
    return {
      type: error.name,
      code: 'veriko_error',
      message: 'El SDK de Veriko rechazó la operación antes de recibir una respuesta de la API.',
    };
  }
  if (error instanceof Error) {
    return { type: error.name, code: 'mcp_internal_error', message: 'Falló el servidor MCP.' };
  }
  return { type: 'Error', code: 'mcp_internal_error', message: 'Error desconocido.' };
}
