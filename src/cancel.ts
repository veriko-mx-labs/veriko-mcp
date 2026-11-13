import { RequestAbortedError } from '@veriko-mx/sdk-runtime';

/** The error a call ends with when the MCP client cancels the request it belongs to. */
export function abortedError(signal: AbortSignal): RequestAbortedError {
  return new RequestAbortedError('The request was cancelled by the client.', { cause: signal.reason });
}
