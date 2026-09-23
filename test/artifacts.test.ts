import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArtifactStore } from '../src/artifacts.js';

describe('recursos descargados', () => {
  it('limita cantidad y memoria con expulsión FIFO', () => {
    const store = new ArtifactStore(2, 8);
    const first = store.put({
      filename: 'uno.txt',
      contentType: 'text/plain',
      content: Buffer.from('1111'),
    });
    const second = store.put({
      filename: 'dos.txt',
      contentType: 'text/plain',
      content: Buffer.from('22'),
    });
    const third = store.put({
      filename: 'tres.txt',
      contentType: 'text/plain',
      content: Buffer.from('33'),
    });

    assert.equal(store.get(first.uri.split('/').pop() ?? ''), undefined);
    assert.ok(store.get(second.uri.split('/').pop() ?? ''));
    assert.ok(store.get(third.uri.split('/').pop() ?? ''));
  });

  it('rechaza un solo archivo mayor que el límite', () => {
    const store = new ArtifactStore(2, 3);
    assert.throws(
      () =>
        store.put({
          filename: 'grande.bin',
          contentType: 'application/octet-stream',
          content: Buffer.from('1234'),
        }),
      /supera el límite/,
    );
  });
});
