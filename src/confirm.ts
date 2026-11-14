import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

const answer = z.object({
  confirm: z.boolean().describe('Marca para ejecutar la operación.'),
});

const FORM = {
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Ejecutar la operación', description: 'Marca para ejecutar la operación.' },
  },
  required: ['confirm'],
};

/** La clave de la respuesta en una petición reintentada, y el nombre del campo del formulario. */
const CONFIRM_KEY = 'confirm';

export type Confirmation =
  | { proceed: true }
  | { proceed: false; result: CallToolResult | InputRequiredResult };

/** Si el cliente declaró que puede mostrar un formulario. */
export function canConfirm(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const elicitation = (declared ?? server.server.getClientCapabilities())?.elicitation;
  if (!elicitation) return false;
  // `elicitation: {}` es soporte de formularios; un cliente que sólo lista `url` no puede mostrar la pregunta.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function notExecuted(reason: 'declined' | 'cancelled' | 'not_confirmed' | 'unavailable'): CallToolResult {
  const message = {
    declined: 'La persona rechazó la operación, así que no se ejecutó. No cambió nada.',
    cancelled: 'La persona cerró la pregunta, así que la operación no se ejecutó. No cambió nada.',
    not_confirmed: 'La persona no marcó la confirmación, así que la operación no se ejecutó. No cambió nada.',
    unavailable: 'El cliente no pudo mostrar la confirmación, así que la operación no se ejecutó. No cambió nada.',
  }[reason];
  const structuredContent = { executed: false, reason, message };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

/**
 * Le pide a la persona que confirme una operación destructiva, cuando el cliente puede preguntar.
 *
 * Un cliente sin la capacidad `elicitation` sigue como antes: el nivel de
 * riesgo (`VERIKO_MCP_MAX_RISK`) sigue siendo la compuerta. En una conexión
 * antigua la pregunta es una petición del servidor; en la revisión 2026-07-28
 * el manejador devuelve un resultado de entrada requerida y el cliente
 * reintenta con la respuesta.
 */
export async function confirmOperation(
  server: McpServer,
  ctx: ServerContext,
  message: string,
): Promise<Confirmation> {
  if (!canConfirm(server, ctx)) return { proceed: true };

  const retried = ctx.mcpReq.inputResponses?.[CONFIRM_KEY];
  if (retried !== undefined) {
    const accepted = acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY, answer);
    if (accepted?.confirm === true) return { proceed: true };
    const action = (retried as { action?: unknown }).action;
    if (action === 'decline') return { proceed: false, result: notExecuted('declined') };
    if (action === 'cancel') return { proceed: false, result: notExecuted('cancelled') };
    return { proceed: false, result: notExecuted('not_confirmed') };
  }

  if (ctx.mcpReq.envelope !== undefined) {
    return {
      proceed: false,
      result: inputRequired({
        inputRequests: { [CONFIRM_KEY]: inputRequired.elicit({ message, requestedSchema: answer }) },
      }),
    };
  }

  try {
    const response = await ctx.mcpReq.elicitInput(
      { mode: 'form', message, requestedSchema: FORM },
      { signal: ctx.mcpReq.signal },
    );
    if (response.action === 'accept') {
      return response.content?.[CONFIRM_KEY] === true
        ? { proceed: true }
        : { proceed: false, result: notExecuted('not_confirmed') };
    }
    return { proceed: false, result: notExecuted(response.action === 'decline' ? 'declined' : 'cancelled') };
  } catch (error) {
    if (ctx.mcpReq.signal.aborted) throw error;
    return { proceed: false, result: notExecuted('unavailable') };
  }
}
