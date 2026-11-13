import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Veriko } from '@veriko-mx/sdk-runtime';

import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { MAX_IMPORT_FILE_BYTES, MAX_RECEIPT_BYTES, parseFileRoots } from '../src/local-files.js';
import { connect, TEST_KEY, type Connected } from './support.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]);

let base: string;
let root: string;
let outside: string;
const open: Connected[] = [];
const received: Array<Record<string, unknown>> = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'veriko-mcp-files-'));
  root = join(base, 'allowed');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  received.length = 0;
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  rmSync(base, { recursive: true, force: true });
});

const fake = {
  validations: {
    validateOcr: async (params: Record<string, unknown>) => {
      received.push(params);
      return { id: 'v1', attributes: { status: 'valid' } };
    },
  },
  beneficiaries: {
    importStart: async (content: Uint8Array, options: Record<string, unknown>) => {
      received.push({ content, ...options });
      return { id: 7, attributes: { status: 'queued' } };
    },
  },
} as unknown as Veriko;

async function session(fileRoots: readonly string[] | undefined) {
  const connected = await connect({
    config: { apiKey: TEST_KEY, profiles: new Set(['all']), maxRisk: 'destructive', ...(fileRoots ? { fileRoots } : {}) },
    client: fake,
  });
  open.push(connected);
  return connected.client;
}

function errorOf(result: { structuredContent?: unknown }) {
  return (result.structuredContent as { error?: { code: string; message: string } }).error;
}

describe('local files (stdio)', () => {
  it('reads a receipt from an allowed directory and sends its bytes', async () => {
    const file = join(root, 'receipt.png');
    writeFileSync(file, PNG);
    const client = await session([root]);

    const result = await client.callTool({ name: 'veriko_validate_ocr', arguments: { image_path: file } });

    assert.equal(result.isError, undefined);
    assert.deepEqual(received[0]?.image, PNG);
    assert.equal(received[0]?.image_path, undefined);
  });

  it('reads an import file and defaults the file name to the one on disk', async () => {
    const file = join(root, 'people.csv');
    writeFileSync(file, 'alias,account\nAna,012180004412345678\n');
    const client = await session([root]);

    const result = await client.callTool({ name: 'veriko_create_beneficiary_import', arguments: { file_path: file } });

    assert.equal(result.isError, undefined);
    assert.equal(received[0]?.filename, 'people.csv');
    assert.equal(Buffer.from(received[0]?.content as Uint8Array).toString('utf8').startsWith('alias,account'), true);
    assert.equal(received[0]?.parseMode, 'template');
  });

  it('refuses paths outside the roots, relative paths, links that leave the roots and wrong types', async () => {
    writeFileSync(join(outside, 'secret.png'), PNG);
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
    writeFileSync(join(root, 'notes.png'), 'not an image');
    const client = await session([root]);

    for (const [path, expected] of [
      [join(outside, 'secret.png'), /outside the directories/],
      [join(root, 'link.png'), /outside the directories/],
      [join(root, '..', 'outside', 'secret.png'), /outside the directories/],
      ['receipt.png', /absolute/],
      [join(root, 'missing.png'), /readable file/],
      [root, /regular file|outside the directories/],
      [join(root, 'notes.png'), /not a JPEG/],
    ] as const) {
      const result = await client.callTool({ name: 'veriko_validate_ocr', arguments: { image_path: path } });
      assert.equal(result.isError, true, path);
      assert.equal(errorOf(result)?.code, 'invalid_file_path', path);
      assert.match(errorOf(result)?.message ?? '', expected, path);
    }
    assert.equal(received.length, 0);
  });

  it('applies the size limits of the spec before sending anything', async () => {
    const big = join(root, 'big.png');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_RECEIPT_BYTES)]));
    const bigImport = join(root, 'big.csv');
    writeFileSync(bigImport, Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1, 'a'));
    const wrongExtension = join(root, 'people.exe');
    writeFileSync(wrongExtension, 'x');
    const client = await session([root]);

    const image = await client.callTool({ name: 'veriko_validate_ocr', arguments: { image_path: big } });
    assert.match(errorOf(image)?.message ?? '', /12 MB/);
    const file = await client.callTool({ name: 'veriko_create_beneficiary_import', arguments: { file_path: bigImport } });
    assert.match(errorOf(file)?.message ?? '', /20 MB/);
    const extension = await client.callTool({
      name: 'veriko_create_beneficiary_import',
      arguments: { file_path: wrongExtension },
    });
    assert.match(errorOf(extension)?.message ?? '', /extension/);
    assert.equal(received.length, 0);
  });

  it('asks for exactly one source', async () => {
    const file = join(root, 'receipt.png');
    writeFileSync(file, PNG);
    const client = await session([root]);

    const both = await client.callTool({
      name: 'veriko_validate_ocr',
      arguments: { image_path: file, image_url: 'https://example.com/a.png' },
    });
    assert.equal(both.isError, true);
    const importBoth = await client.callTool({
      name: 'veriko_create_beneficiary_import',
      arguments: { file_path: file, file_base64: 'YQ==', filename: 'a.csv' },
    });
    assert.equal(importBoth.isError, true);
    const noName = await client.callTool({
      name: 'veriko_create_beneficiary_import',
      arguments: { file_base64: 'YQ==' },
    });
    assert.equal(noName.isError, true);
  });

  it('does not advertise or accept paths without VERIKO_MCP_FILE_ROOTS', async () => {
    const file = join(root, 'receipt.png');
    writeFileSync(file, PNG);
    const client = await session(undefined);

    const { tools } = await client.listTools();
    for (const name of ['veriko_validate_ocr', 'veriko_create_beneficiary_import']) {
      const properties = Object.keys(tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
      assert.equal(properties.includes('image_path') || properties.includes('file_path'), false, name);
    }
    const result = await client.callTool({ name: 'veriko_validate_ocr', arguments: { image_path: file } });
    assert.equal(result.isError, true);
    assert.equal(received.length, 0);
  });

  it('advertises the path arguments when roots are set', async () => {
    const client = await session([root]);
    const { tools } = await client.listTools();
    const ocr = tools.find((tool) => tool.name === 'veriko_validate_ocr');
    const importTool = tools.find((tool) => tool.name === 'veriko_create_beneficiary_import');
    assert.ok(Object.keys(ocr?.inputSchema.properties ?? {}).includes('image_path'));
    assert.ok(Object.keys(importTool?.inputSchema.properties ?? {}).includes('file_path'));
  });

  it('reads the roots from the environment and rejects relative ones', () => {
    assert.deepEqual(loadConfig({ VERIKO_MCP_FILE_ROOTS: root }).fileRoots, [root]);
    assert.equal(loadConfig({}).fileRoots, undefined);
    assert.deepEqual(parseFileRoots(undefined), []);
    assert.throws(() => parseFileRoots('relative/dir'), /absolute/);
  });
});

describe('local files (HTTP)', () => {
  it('never advertises or reads paths over HTTP, even with roots configured', async () => {
    const file = join(root, 'receipt.png');
    writeFileSync(file, PNG);
    const app = createHttpApp({
      config: { apiKey: '', profiles: new Set(['all']), maxRisk: 'destructive', fileRoots: [root] },
      clientFactory: () => fake,
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TEST_KEY}`,
      host: 'localhost',
    };
    const post = async (body: unknown) =>
      (await app.fetch(new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(body) }))).text();

    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.match(list, /veriko_validate_ocr/);
    assert.doesNotMatch(list, /image_path|file_path/);

    const call = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'veriko_validate_ocr', arguments: { image_path: file } },
    });
    assert.match(call, /Invalid arguments|unrecognized|isError/i);
    assert.equal(received.length, 0);
    await app.close();
  });
});
