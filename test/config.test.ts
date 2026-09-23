import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';

describe('configuración del servidor', () => {
  it('aplica core y write también a variables vacías', () => {
    const config = loadConfig({ VERIKO_MCP_PROFILE: ' ', VERIKO_MCP_MAX_RISK: '' });
    assert.deepEqual([...config.profiles], ['core']);
    assert.equal(config.maxRisk, 'write');
  });

  it('normaliza listas de perfiles y conserva la clave fuera del catálogo', () => {
    const config = loadConfig({
      VERIKO_API_KEY: '  veriko_prueba  ',
      VERIKO_MCP_PROFILE: ' plans, catalog,plans ',
      VERIKO_MCP_MAX_RISK: ' read ',
    });
    assert.equal(config.apiKey, 'veriko_prueba');
    assert.deepEqual([...config.profiles], ['plans', 'catalog']);
    assert.equal(config.maxRisk, 'read');
  });

  it('rechaza perfiles y riesgos desconocidos', () => {
    assert.throws(() => loadConfig({ VERIKO_MCP_PROFILE: 'inexistente' }), /perfiles desconocidos/);
    assert.throws(() => loadConfig({ VERIKO_MCP_MAX_RISK: 'dangerous' }), /debe ser read/);
  });

  it('exige HTTPS para hosts remotos y no admite credenciales en la URL', () => {
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
      /debe usar HTTPS/,
    );
    assert.throws(
      () => loadConfig({ VERIKO_BASE_URL: 'https://user:secret@example.test/v1' }),
      /credenciales incrustadas/,
    );
  });
});
