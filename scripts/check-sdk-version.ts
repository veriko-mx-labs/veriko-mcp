/**
 * Avisa cuando el SDK que consume el MCP se quedó atrás.
 *
 * La cadena de sincronización es spec → SDK → MCP: el reusable de la organización
 * regenera el SDK cuando el portal publica un contrato nuevo. El MCP fija el SDK por
 * versión e integridad, así que una versión nueva del SDK no llega sola: alguien tiene
 * que moverla.
 *
 * `check:surface` no cubre ese tramo. Detecta que el contrato cambió, no que llegó el
 * SDK que ya lo implementa. Entre una cosa y la otra puede pasar una versión entera
 * sin que nada lo diga.
 *
 * Esto no actualiza nada por su cuenta: informa. Subir el SDK cambia el
 * lockfile y el artefacto publicable, y eso se revisa en un PR.
 */
import { readFileSync } from 'node:fs';

const REGISTRO = 'https://registry.npmjs.org/@veriko-mx%2Fsdk';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

const pinned = packageJson.dependencies?.['@veriko-mx/sdk-runtime'];
if (!pinned) {
  throw new Error('No hay dependencia `@veriko-mx/sdk-runtime` en package.json.');
}

const fijada = /^npm:@veriko-mx\/sdk@(\d+\.\d+\.\d+)$/.exec(pinned)?.[1];
if (!fijada) {
  throw new Error(
    `La fuente del SDK dejó de ser una versión exacta de npm (${pinned}); ` +
      'revisa a mano que siga siendo inmutable antes de tocar este candado.',
  );
}

// El registro es público y no pide credencial, así que esto ya no depende de un
// token ni de la cuota de la API de GitHub.
const response = await fetch(REGISTRO, {
  cache: 'no-store',
  headers: { accept: 'application/json' },
});
if (!response.ok) {
  throw new Error(`No fue posible leer @veriko-mx/sdk en npm: HTTP ${response.status}.`);
}

const cuerpo = (await response.json()) as { 'dist-tags'?: Record<string, string> };
const publicada = cuerpo['dist-tags']?.latest ?? '';
if (!/^\d+\.\d+\.\d+$/.test(publicada)) {
  throw new Error(`@veriko-mx/sdk no trae un \`latest\` legible (${publicada}).`);
}

if (publicada !== fijada) {
  throw new Error(
    `El SDK avanzó a ${publicada} y el MCP sigue en ${fijada}.\n` +
      'Para ponerlo al día:\n' +
      `  1. pon \`@veriko-mx/sdk-runtime\` en \`npm:@veriko-mx/sdk@${publicada}\` en package.json;\n` +
      '  2. `npm install` para refijar la integridad en el lockfile;\n' +
      '  3. `npm run check` y `npm run check:surface`, que dirá si la superficie cambió;\n' +
      '  4. abre el PR: subir el SDK cambia el artefacto publicable.',
  );
}

process.stdout.write(`SDK al día: el MCP consume ${fijada}, la última publicada en npm.\n`);
