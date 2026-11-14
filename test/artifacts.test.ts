import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArtifactStore,
  isTextMimeType,
  resolveMimeType,
  resourceContents,
} from '../src/artifacts.js';

describe('recursos descargados', () => {
  it('limita la cantidad y la memoria, y descarta primero lo más antiguo', () => {
    const store = new ArtifactStore(2, 8);
    const first = store.put({ filename: 'one.txt', contentType: 'text/plain', content: Buffer.from('1111') });
    const second = store.put({ filename: 'two.txt', contentType: 'text/plain', content: Buffer.from('22') });
    const third = store.put({ filename: 'three.txt', contentType: 'text/plain', content: Buffer.from('33') });

    assert.equal(store.get(first.uri.split('/').pop() ?? ''), undefined);
    assert.ok(store.get(second.uri.split('/').pop() ?? ''));
    assert.ok(store.get(third.uri.split('/').pop() ?? ''));
  });

  it('rechaza un archivo individual mayor que el límite', () => {
    const store = new ArtifactStore(2, 3);
    assert.throws(
      () =>
        store.put({
          filename: 'large.bin',
          contentType: 'application/octet-stream',
          content: Buffer.from('1234'),
        }),
      /supera el límite de recursos/,
    );
  });
});

describe('tipos de medio de las descargas', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);

  it('conserva un tipo específico que declara la API y quita los parámetros', () => {
    assert.equal(
      resolveMimeType({ filename: 'a.xml', contentType: 'application/xml; charset=utf-8', content: bytes() }),
      'application/xml',
    );
  });

  it('infiere el tipo por el nombre del archivo cuando la API dice octet-stream', () => {
    const octet = 'application/octet-stream';
    assert.equal(resolveMimeType({ filename: 'plantilla.csv', contentType: octet, content: bytes() }), 'text/csv');
    assert.equal(
      resolveMimeType({ filename: 'export.xlsx', contentType: octet, content: bytes() }),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.equal(resolveMimeType({ filename: 'CEP.pdf', contentType: octet, content: bytes() }), 'application/pdf');
  });

  it('recurre a los primeros bytes', () => {
    const octet = 'application/octet-stream';
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(0x25, 0x50, 0x44, 0x46) }), 'application/pdf');
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(0x50, 0x4b, 3, 4) }), 'application/zip');
    assert.equal(resolveMimeType({ filename: 'x', contentType: octet, content: bytes(1, 2, 3) }), 'application/octet-stream');
  });

  it('distingue los tipos de texto de los binarios y llena text o blob según corresponda', () => {
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
