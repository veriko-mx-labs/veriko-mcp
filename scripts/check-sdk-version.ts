/**
 * Avisa cuando el SDK que consume el MCP se quedó atrás.
 *
 * La cadena de sincronización es spec, luego SDK, luego MCP: el workflow
 * reutilizable de la organización regenera el SDK cuando el portal publica un
 * contrato nuevo. El MCP fija el SDK por versión e integridad, así que una
 * versión nueva del SDK no llega sola: alguien tiene que moverla.
 *
 * `check:surface` no cubre ese paso. Detecta que el contrato cambió, no que
 * llegó el SDK que lo implementa. Puede pasar una versión completa entre los
 * dos sin que nada lo diga.
 *
 * Esto no actualiza nada por sí mismo: informa. Subir el SDK cambia el
 * lockfile y el artefacto que se publica, y eso se revisa en un PR.
 */
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/@veriko-mx%2Fsdk';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

const pinnedSpec = packageJson.dependencies?.['@veriko-mx/sdk-runtime'];
if (!pinnedSpec) {
  throw new Error('package.json no tiene la dependencia `@veriko-mx/sdk-runtime`.');
}

const pinned = /^npm:@veriko-mx\/sdk@(\d+\.\d+\.\d+)$/.exec(pinnedSpec)?.[1];
if (!pinned) {
  throw new Error(
    `El origen del SDK ya no es una versión exacta de npm (${pinnedSpec}); ` +
      'comprueba a mano que siga siendo inmutable antes de cambiar este candado.',
  );
}

// El registro es público y no necesita credencial, así que esto ya no depende de
// un token ni de la cuota de la API de GitHub.
const response = await fetch(REGISTRY, {
  cache: 'no-store',
  headers: { accept: 'application/json' },
});
if (!response.ok) {
  throw new Error(`No se pudo leer @veriko-mx/sdk en npm: HTTP ${response.status}.`);
}

const document = (await response.json()) as { 'dist-tags'?: Record<string, string> };
const published = document['dist-tags']?.latest ?? '';
if (!/^\d+\.\d+\.\d+$/.test(published)) {
  throw new Error(`@veriko-mx/sdk no tiene un \`latest\` legible (${published}).`);
}

if (published !== pinned) {
  throw new Error(
    `El SDK avanzó a ${published} y el MCP sigue en ${pinned}.\n` +
      'Para ponerte al día:\n' +
      `  1. cambia \`@veriko-mx/sdk-runtime\` a \`npm:@veriko-mx/sdk@${published}\` en package.json;\n` +
      '  2. ejecuta `npm install` para fijar de nuevo la integridad en el lockfile;\n' +
      '  3. ejecuta `npm run check` y `npm run check:surface`, que dice si cambió la superficie;\n' +
      '  4. abre el PR: subir el SDK cambia el artefacto que se publica.',
  );
}

process.stdout.write(`SDK al día: el MCP usa ${pinned}, la última versión publicada en npm.\n`);
