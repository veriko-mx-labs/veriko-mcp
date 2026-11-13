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
  confirm: z.boolean().describe('Check to run the operation.'),
});

const FORM = {
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Run the operation', description: 'Check to run the operation.' },
  },
  required: ['confirm'],
};

/** The key of the answer in a retried request, and the name of the form field. */
const CONFIRM_KEY = 'confirm';

export type Confirmation =
  | { proceed: true }
  | { proceed: false; result: CallToolResult | InputRequiredResult };

/** Whether the client declared that it can show a form. */
export function canConfirm(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const elicitation = (declared ?? server.server.getClientCapabilities())?.elicitation;
  if (!elicitation) return false;
  // `elicitation: {}` is form support; a client that lists only `url` cannot show the question.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function notExecuted(reason: 'declined' | 'cancelled' | 'not_confirmed' | 'unavailable'): CallToolResult {
  const message = {
    declined: 'The user declined, so the operation did not run. Nothing changed.',
    cancelled: 'The user dismissed the question, so the operation did not run. Nothing changed.',
    not_confirmed: 'The user did not check the confirmation, so the operation did not run. Nothing changed.',
    unavailable: 'The client could not show the confirmation, so the operation did not run. Nothing changed.',
  }[reason];
  const structuredContent = { executed: false, reason, message };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

/**
 * Asks the person to confirm a destructive operation, when the client can ask.
 *
 * A client without the `elicitation` capability proceeds as before: the risk
 * level (`VERIKO_MCP_MAX_RISK`) remains the gate. On a legacy connection the
 * question is a server request; on the 2026-07-28 revision the handler returns
 * an input-required result and the client retries with the answer.
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
