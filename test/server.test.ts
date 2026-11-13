import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { ALL, clientFor, connect, json, startFakeApi, type Connected, type FakeApi } from './support.js';

let api: FakeApi;
const open: Connected[] = [];

beforeEach(async () => {
  api = await startFakeApi();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  await api.close();
});

async function session(options: Parameters<typeof connect>[0] = {}) {
  const connected = await connect({ config: ALL, client: clientFor(api), ...options });
  open.push(connected);
  return connected;
}

const VALIDATION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const fields = {
  amount: 100,
  tracking_key: 'ABC-123',
  beneficiary_account: '012180004412345678',
};

function text(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

describe('MCP server', () => {
  it('announces only the requested profile and runs a public operation', async () => {
    const fake = {
      plans: {
        listPublic: async () => ({ data: [{ id: 'integrator' }] }),
        getPublicPlanComparison: async () => ({ data: [] }),
      },
    } as unknown as Veriko;
    const { client } = await session({
      client: fake,
      config: { apiKey: '', profiles: new Set(['plans']), maxRisk: 'read' },
    });

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'veriko_get_public_plan_comparison',
      'veriko_list_public_plans',
    ]);

    const result = await client.callTool({ name: 'veriko_list_public_plans', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { data: [{ id: 'integrator' }] });
  });

  it('declares an outputSchema and annotations on every tool, and identity with instructions', async () => {
    const { client } = await session();
    const { tools } = await client.listTools();

    assert.equal(tools.length, 76);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, 'object', tool.name);
      assert.ok(tool.annotations, tool.name);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.idempotentHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', tool.name);
    }
    const validate = tools.find((tool) => tool.name === 'veriko_validate_direct');
    assert.equal(validate?.annotations?.readOnlyHint, false);
    assert.equal(validate?.annotations?.destructiveHint, false);
    assert.equal(validate?.annotations?.openWorldHint, true);
    const info = client.getServerVersion();
    assert.equal(info?.name, 'veriko-mcp-server');
    assert.equal(info?.title, 'Veriko');
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /veriko_wait_for_validation/);
    assert.match(instructions, /idempotency_key/);
    assert.doesNotMatch(instructions, /[áéíóúñ]/);
  });

  it('returns structured content that satisfies the output schema', async () => {
    api.reply = (_request, response) =>
      json(response, 200, {
        data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'valid', account_cross_checked: true } },
      });
    const { client } = await session();

    const result = await client.callTool({ name: 'veriko_validate_direct', arguments: fields });

    assert.equal(result.isError, undefined);
    const body = result.structuredContent as { id?: string; attributes?: { status?: string } };
    assert.equal(body.id, VALIDATION_ID);
    assert.equal(body.attributes?.status, 'valid');
  });

  it('sends a fresh Idempotency-Key per call and surfaces the key and the replay', async () => {
    let calls = 0;
    api.reply = (_request, response) => {
      calls += 1;
      json(
        response,
        200,
        { data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'valid' } } },
        calls === 3 ? { 'Idempotent-Replayed': 'true' } : {},
      );
    };
    const { client } = await session();

    await client.callTool({ name: 'veriko_validate_direct', arguments: fields });
    await client.callTool({ name: 'veriko_validate_direct', arguments: fields });
    const replay = await client.callTool({
      name: 'veriko_validate_direct',
      arguments: { ...fields, idempotency_key: 'order-4812' },
    });

    const keys = api.seen.map((request) => request.headers['idempotency-key']);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(keys[2], 'order-4812');
    const call = (replay.structuredContent as { _call?: Record<string, unknown> })._call;
    assert.equal(call?.idempotent_replayed, true);
    assert.equal(call?.idempotency_key, 'order-4812');
  });

  it('surfaces quota headers and a warning when the allowance is nearly spent', async () => {
    api.reply = (_request, response) =>
      json(response, 200, { data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'valid' } } }, {
        'X-Quota-Limit': '100',
        'X-Quota-Used': '95',
        'X-Quota-Remaining': '5',
        'X-Quota-Reset': '2026-12-01T00:00:00Z',
      });
    const { client } = await session();

    const result = await client.callTool({ name: 'veriko_validate_direct', arguments: fields });

    const call = (result.structuredContent as { _call?: { quota?: Record<string, unknown>; quota_warning?: string } })._call;
    assert.deepEqual(call?.quota, { limit: 100, used: 95, remaining: 5, reset: '2026-12-01T00:00:00Z' });
    assert.match(call?.quota_warning ?? '', /Only 5 of 100 validations remain/);
  });

  it('surfaces the rate-limit window and the deprecation of an operation from the response metadata', async () => {
    api.reply = (_request, response) =>
      json(
        response,
        200,
        { data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'valid' } }, meta: { request_id: 'req_meta' } },
        {
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Remaining': '58',
          'X-RateLimit-Reset': '1790000000',
          Deprecation: 'true',
          Sunset: 'Wed, 01 Jul 2026 00:00:00 GMT',
        },
      );
    const { client } = await session();

    const result = await client.callTool({ name: 'veriko_validate_direct', arguments: fields });

    const call = (result.structuredContent as { _call?: Record<string, unknown> })._call;
    assert.deepEqual(call?.rate_limit, { limit: 60, remaining: 58, reset: new Date(1790000000 * 1000).toISOString() });
    assert.equal(call?.deprecation, 'true');
    assert.equal(call?.sunset, 'Wed, 01 Jul 2026 00:00:00 GMT');
    assert.equal(call?.request_id, 'req_meta');
  });

  it('returns the full errors list of a 422 as an error result the model can act on', async () => {
    api.reply = (_request, response) =>
      json(response, 422, {
        errors: [
          { status: '422', code: 'validation_error', detail: 'The request is invalid.' },
          {
            status: '422',
            code: 'candidate_accounts_too_many',
            detail: 'Too many.',
            hint: 'Send at most 3.',
            docs_url: 'https://docs.veriko.mx/en/concepts/errors-taxonomy',
            source: { pointer: '/candidate_accounts' },
            meta: { max: 3 },
          },
        ],
        meta: { request_id: 'req_9' },
      });
    const { client } = await session();

    const result = await client.callTool({ name: 'veriko_validate_direct', arguments: fields });

    assert.equal(result.isError, true);
    const { error } = result.structuredContent as { error: Record<string, unknown> & { errors: Array<Record<string, unknown>> } };
    assert.equal(error.status, 422);
    assert.equal(error.code, 'validation_error');
    assert.equal(error.request_id, 'req_9');
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[1]?.pointer, '/candidate_accounts');
    assert.equal(error.errors[1]?.hint, 'Send at most 3.');
    assert.match(String(error.idempotency_key), /^veriko_mcp_/);
    assert.deepEqual(JSON.parse(text(result)), { error });
  });

  it('returns a quota 429 at once, with retry_after_seconds and the quota facts', async () => {
    api.reply = (_request, response) =>
      json(
        response,
        429,
        { errors: [{ status: '429', code: 'quota_exceeded', detail: 'Quota spent.' }] },
        { 'Retry-After': '86400', 'X-Quota-Limit': '100', 'X-Quota-Used': '100', 'X-Quota-Remaining': '0' },
      );
    const started = Date.now();
    const { client } = await session({ client: clientFor(api, { maxRetries: 2 }) });

    const result = await client.callTool({ name: 'veriko_validate_direct', arguments: fields });

    assert.ok(Date.now() - started < 3_000);
    assert.equal(api.seen.length, 1);
    const { error } = result.structuredContent as { error: Record<string, unknown> };
    assert.equal(error.kind, 'quota');
    assert.equal(error.retryable, false);
    assert.equal(error.retry_after_seconds, 86_400);
    assert.match(String(error.quota_warning), /quota is spent/);
  });

  it('treats a 304 as a success', async () => {
    api.reply = (_request, response) => {
      response.statusCode = 304;
      response.end();
    };
    const { client } = await session();

    const result = await client.callTool({
      name: 'veriko_get_validation',
      arguments: { validation_id: VALIDATION_ID, if_none_match: 'W/"3-processing"' },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { not_modified: true, etag: 'W/"3-processing"' });
  });

  it('sends the User-Agent with the MCP, its transport and the SDK', async () => {
    const { client } = await session();
    await client.callTool({ name: 'veriko_list_webhooks', arguments: {} });
    assert.match(
      String(api.seen[0]?.headers['user-agent']),
      /^veriko-mcp\/0\.0\.0-test \(stdio\) veriko-sdk-js\/\d+\.\d+\.\d+ \(node /,
    );
  });

  it('rotates a webhook secret immediately with the immediate body', async () => {
    api.reply = (_request, response) =>
      json(response, 200, { data: { type: 'webhook_endpoint', id: 'w1', attributes: { secret: 'whsec_x' } } });
    const { client } = await session();
    const webhook_id = '247af42e-1fd9-4d31-a330-a45d9d6ddbe5';

    const immediate = await client.callTool({
      name: 'veriko_regenerate_webhook_secret',
      arguments: { webhook_id, immediate: true },
    });
    await client.callTool({ name: 'veriko_regenerate_webhook_secret', arguments: { webhook_id } });

    assert.equal(api.seen[0]?.url, `/v1/webhooks/${webhook_id}/regenerate-secret`);
    assert.deepEqual(JSON.parse(api.seen[0]?.body ?? '{}'), { immediate: true });
    assert.equal(api.seen[1]?.body, '');
    assert.equal((immediate.structuredContent as { id?: string }).id, 'w1');
  });

  it('embeds a small CEP XML as text and stores it for resources/read', async () => {
    api.reply = (_request, response) => {
      response.setHeader('content-type', 'application/xml');
      response.setHeader('content-disposition', 'attachment; filename="CEP.xml"');
      response.end('<cep>ok</cep>');
    };
    const { client } = await session();

    const result = await client.callTool({
      name: 'veriko_download_cep',
      arguments: { validation_id: VALIDATION_ID },
    });

    const content = result.content as Array<{ type: string; resource?: { mimeType?: string; text?: string; uri?: string } }>;
    const embedded = content.find((item) => item.type === 'resource');
    assert.equal(embedded?.resource?.mimeType, 'application/xml');
    assert.equal(embedded?.resource?.text, '<cep>ok</cep>');
    const artifact = (result.structuredContent as { artifact: { uri: string }; embedded: boolean });
    assert.equal(artifact.embedded, true);
    const read = await client.readResource({ uri: artifact.artifact.uri });
    assert.equal((read.contents[0] as { text?: string }).text, '<cep>ok</cep>');
  });

  it('returns a resource link for a file over the embedding limit', async () => {
    api.reply = (_request, response) => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.alloc(2_000, 1));
    };
    const { client } = await session({ maxEmbeddedArtifactBytes: 1_000 });

    const result = await client.callTool({
      name: 'veriko_download_cep',
      arguments: { validation_id: VALIDATION_ID, format: 'pdf' },
    });

    const content = result.content as Array<{ type: string; mimeType?: string }>;
    assert.equal(content.some((item) => item.type === 'resource_link' && item.mimeType === 'application/pdf'), true);
    assert.equal(content.some((item) => item.type === 'resource'), false);
    assert.equal((result.structuredContent as { embedded: boolean }).embedded, false);
  });

  it('gives an octet-stream export the right type from its file name', async () => {
    api.reply = (_request, response) => {
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('content-disposition', 'attachment; filename="validations.csv"');
      response.end('a,b\n1,2\n');
    };
    const { client } = await session();

    const result = await client.callTool({ name: 'veriko_export_validations', arguments: {} });

    assert.equal((result.structuredContent as { artifact: { mimeType: string } }).artifact.mimeType, 'text/csv');
  });

  it('cuts only the text block of a very large result, never the structured content', async () => {
    api.reply = (_request, response) =>
      json(response, 200, { data: Array.from({ length: 200 }, (_, index) => ({ id: index, note: 'x'.repeat(50) })) });
    const { client } = await session({ maxTextChars: 500 });

    const result = await client.callTool({ name: 'veriko_list_validations', arguments: {} });

    assert.match(text(result), /\[truncated at 500 characters/);
    assert.equal((result.structuredContent as { items: unknown[] }).items.length, 200);
  });
});

describe('resources and prompts', () => {
  it('lists the reference resources, including documentation links in English', async () => {
    const { client } = await session();

    const resources = await client.listResources();
    const uris = resources.resources.map((resource) => resource.uri);
    for (const uri of ['veriko://catalog/banks', 'veriko://plans', 'veriko://status/banxico', 'veriko://docs']) {
      assert.ok(uris.includes(uri), uri);
    }
    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((item) => item.uriTemplate === 'veriko://catalog/spei-calendar/{year}'));

    const docs = await client.readResource({ uri: 'veriko://docs' });
    assert.match((docs.contents[0] as { text: string }).text, /https:\/\/docs\.veriko\.mx\/en\/concepts\/idempotency/);
  });

  it('reads the bank catalog through the API', async () => {
    api.reply = (_request, response) => json(response, 200, { data: [{ code: '40012', name: 'BBVA MEXICO' }] });
    const { client } = await session();

    const read = await client.readResource({ uri: 'veriko://catalog/banks' });

    assert.equal(api.seen[0]?.url, '/v1/public/banks');
    assert.equal((read.contents[0] as { mimeType?: string }).mimeType, 'application/json');
    assert.match((read.contents[0] as { text: string }).text, /BBVA MEXICO/);
  });

  it('reads a SPEI calendar year from the template', async () => {
    api.reply = (_request, response) => json(response, 200, { data: { attributes: { year: 2026 } } });
    const { client } = await session();

    await client.readResource({ uri: 'veriko://catalog/spei-calendar/2026' });

    assert.equal(api.seen[0]?.url, '/v1/public/spei-calendar/2026');
  });

  it('offers reusable prompts that name real tools', async () => {
    const { client } = await session();

    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((prompt) => prompt.name).sort();
    assert.deepEqual(names, [
      'check_transfer',
      'export_validations',
      'import_beneficiaries',
      'reconcile_month',
      'set_up_webhook',
      'triage_failed_validations',
    ]);

    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((tool) => tool.name));
    for (const name of names) {
      const prompt = await client.getPrompt({
        name,
        arguments:
          name === 'check_transfer'
            ? { details: '100 MXN, key ABC' }
            : name === 'reconcile_month'
              ? { month: '2026-09' }
              : name === 'set_up_webhook'
                ? { url: 'https://example.com/h' }
                : {},
      });
      const body = (prompt.messages[0]?.content as { text: string }).text;
      for (const mentioned of body.match(/veriko_[a-z_]+/g) ?? []) {
        assert.ok(toolNames.has(mentioned), `${name} mentions unknown tool ${mentioned}`);
      }
    }
  });
});
