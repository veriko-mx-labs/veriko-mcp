import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';

describe('server configuration', () => {
  it('applies core and write to empty variables too', () => {
    const config = loadConfig({ VERIKO_MCP_PROFILE: ' ', VERIKO_MCP_MAX_RISK: '' });
    assert.deepEqual([...config.profiles], ['core']);
    assert.equal(config.maxRisk, 'write');
  });

  it('normalizes profile lists and keeps the key outside the catalog', () => {
    const config = loadConfig({
      VERIKO_API_KEY: '  veriko_test  ',
      VERIKO_MCP_PROFILE: ' plans, catalog,plans ',
      VERIKO_MCP_MAX_RISK: ' read ',
    });
    assert.equal(config.apiKey, 'veriko_test');
    assert.deepEqual([...config.profiles], ['plans', 'catalog']);
    assert.equal(config.maxRisk, 'read');
  });

  it('rejects unknown profiles and risks', () => {
    assert.throws(() => loadConfig({ VERIKO_MCP_PROFILE: 'nonexistent' }), /unknown profiles/);
    assert.throws(() => loadConfig({ VERIKO_MCP_MAX_RISK: 'dangerous' }), /must be read/);
  });

  it('requires HTTPS for remote hosts and rejects credentials in the URL', () => {
    assert.equal(
      loadConfig({ VERIKO_BASE_URL: 'https://sandbox.veriko.mx/v1' }).baseUrl,
      'https://sandbox.veriko.mx/v1',
    );
    assert.equal(
      loadConfig({ VERIKO_BASE_URL: 'http://127.0.0.1:8080' }).baseUrl,
      'http://127.0.0.1:8080',
    );
    assert.throws(
      () => loadConfig({ VERIKO_BASE_URL: 'http://example.test/v1' }),
      /must use HTTPS/,
    );
    assert.throws(
      () => loadConfig({ VERIKO_BASE_URL: 'https://user:secret@example.test/v1' }),
      /embedded credentials/,
    );
  });
});
