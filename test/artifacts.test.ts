import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArtifactStore,
  isTextMimeType,
  resolveMimeType,
  resourceContents,
} from '../src/artifacts.js';

describe('downloaded resources', () => {
  it('limits count and memory with FIFO eviction', () => {
    const store = new ArtifactStore(2, 8);
    const first = store.put({ filename: 'one.txt', contentType: 'text/plain', content: Buffer.from('1111') });
    const second = store.put({ filename: 'two.txt', contentType: 'text/plain', content: Buffer.from('22') });
    const third = store.put({ filename: 'three.txt', contentType: 'text/plain', content: Buffer.from('33') });

    assert.equal(store.get(first.uri.split('/').pop() ?? ''), undefined);
    assert.ok(store.get(second.uri.split('/').pop() ?? ''));
    assert.ok(store.get(third.uri.split('/').pop() ?? ''));
  });

  it('rejects a single file larger than the limit', () => {
    const store = new ArtifactStore(2, 3);
    assert.throws(
      () =>
        store.put({
          filename: 'large.bin',
          contentType: 'application/octet-stream',
          content: Buffer.from('1234'),
        }),
      /exceeds the resource limit/,
    );
  });
});

describe('media types of downloads', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);

  it('keeps a specific type the API declares and drops parameters', () => {
    assert.equal(
      resolveMimeType({ filename: 'a.xml', contentType: 'application/xml; charset=utf-8', content: bytes() }),
      'application/xml',
    );
  });

  it('infers the type from the file name when the API says octet-stream', () => {
    const octet = 'application/octet-stream';
    assert.equal(resolveMimeType({ filename: 'plantilla.csv', contentType: octet, content: bytes() }), 'text/csv');
    assert.equal(
      resolveMimeType({ filename: 'export.xlsx', contentType: octet, content: bytes() }),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(resolveMimeType({ filename: 'CEP.pdf', contentType: octet, content: bytes() }), 'application/pdf');
  });

  it('falls back to the leading bytes', () => {
    const octet = 'application/octet-stream';
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(0x25, 0x50, 0x44, 0x46) }), 'application/pdf');
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(0x50, 0x4b, 3, 4) }), 'application/zip');
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(1, 2, 3) }), 'application/octet-stream');
  });

  it('tells text from binary types and fills text or blob accordingly', () => {
    assert.equal(isTextMimeType('application/xml'), true);
    assert.equal(isTextMimeType('text/csv'), true);
    assert.equal(isTextMimeType('application/pdf'), false);
    assert.deepEqual(resourceContents('veriko://a', 'text/csv', Buffer.from('a,b')), {
      uri: 'veriko://a',
      mimeType: 'text/csv',
      text: 'a,b',
    });
    assert.deepEqual(resourceContents('veriko://a', 'application/pdf', Buffer.from('%PDF')), {
      uri: 'veriko://a',
      mimeType: 'application/pdf',
      blob: Buffer.from('%PDF').toString('base64'),
    });
  });
});
