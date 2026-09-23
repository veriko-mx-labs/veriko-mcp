/**
 * Arnés de evaluación del catálogo.
 *
 * Tiene dos modos, y la diferencia importa:
 *
 * - `oraculo` (el que corre hoy, y el que corre en CI): comprueba que cada
 *   escenario es realmente medible. Ejecuta la herramienta esperada contra el
 *   servidor MCP con el SDK falso, y verifica que la respuesta del servidor
 *   satisface `comprobar`. Si esto falla, el escenario está mal escrito o el
 *   conjunto de datos ya no responde la pregunta; medir un modelo con él daría
 *   una cifra sin sentido. No usa modelos, no cuesta y no necesita claves.
 *
 * - `modelo` (no implementado a propósito): la comparativa real entre perfiles.
 *   Necesita un cliente y una clave del proveedor, y cuesta dinero por corrida,
 *   así que no se ejecuta sin que Veriko lo autorice. La interfaz está declarada
 *   abajo: recibe la pregunta, devuelve el texto final y las llamadas que hizo.
 */
import { pathToFileURL } from 'node:url';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { crearApiFalsa, cargarDatos, type Llamada } from './api-falsa.js';
import { ESCENARIOS, type Escenario } from './escenarios.js';
import { TOOL_CATALOG } from '../src/catalog.js';
import { createVerikoServer } from '../src/server.js';
import type { Profile, Risk } from '../src/config.js';

export interface Resultado {
  escenario: string;
  correcto: boolean;
  porElCaminoEsperado: boolean;
  detalle: string;
}

function nombreDeHerramienta(operationId: string): string {
  const tool = TOOL_CATALOG.find((item) => item.operationId === operationId);
  if (!tool) throw new Error(`el catálogo no tiene la operación ${operationId}`);
  return tool.name;
}

/** Texto plano de lo que el servidor devolvió, que es lo que leería el modelo. */
function textoDelResultado(resultado: unknown): string {
  const { content, structuredContent } = resultado as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
  const prosa = (content ?? [])
    .filter((parte) => parte.type === 'text' && typeof parte.text === 'string')
    .map((parte) => parte.text)
    .join('\n');
  return `${prosa}\n${JSON.stringify(structuredContent ?? {})}`;
}

async function correrEscenario(escenario: Escenario): Promise<Resultado> {
  const { client: fake, llamadas } = crearApiFalsa(cargarDatos());
  const server = createVerikoServer({
    client: fake,
    config: {
      apiKey: '',
      profiles: new Set<Profile>([escenario.perfil as Profile]),
      maxRisk: 'read' as Risk,
    },
  });
  const client = new Client({ name: 'veriko-evals', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const anunciadas = (await client.listTools()).tools.map((tool) => tool.name);
    const esperada = nombreDeHerramienta(escenario.operacion);
    if (!anunciadas.includes(esperada)) {
      return {
        escenario: escenario.id,
        correcto: false,
        porElCaminoEsperado: false,
        detalle: `el perfil ${escenario.perfil} no anuncia ${esperada}`,
      };
    }

    const resultado = await client.callTool({
      name: esperada,
      arguments: argumentosDe(escenario),
    });
    const texto = textoDelResultado(resultado);

    return {
      escenario: escenario.id,
      correcto: escenario.comprobar(texto),
      porElCaminoEsperado: caminoCoincide(llamadas, escenario.metodosEsperados),
      detalle: texto.slice(0, 160).replace(/\s+/g, ' '),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Los argumentos del camino de referencia; el modelo los deducirá solo. */
function argumentosDe(escenario: Escenario): Record<string, unknown> {
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(escenario.pregunta)?.[1];
  if (id) return { validationId: id };
  if (escenario.id === 'E04-contar-por-estado') return { status: 'pending' };
  if (escenario.id === 'E09-bin-desconocido') return { bin: '999999' };
  return {};
}

function caminoCoincide(llamadas: readonly Llamada[], esperados: readonly string[]): boolean {
  return esperados.every((metodo) => llamadas.some((llamada) => llamada.metodo === metodo));
}

/**
 * La interfaz del modo `modelo`.
 *
 * Un cliente real recibe la pregunta y el catálogo anunciado por un perfil, y
 * devuelve su respuesta final junto con las herramientas que llamó para
 * llegar. Con eso se puntúa lo que se quiere comparar entre `core`, las
 * familias y `all`: aciertos, llamadas equivocadas, tokens de catálogo y
 * reintentos.
 *
 * No hay implementación aquí a propósito. Correrla cuesta dinero y necesita
 * una clave del proveedor; Veriko decide cuándo y con qué clientes.
 */
export interface ClienteDeModelo {
  responder(pregunta: string, perfil: string): Promise<{ texto: string; herramientas: string[] }>;
}

export async function correrOraculo(): Promise<readonly Resultado[]> {
  const resultados: Resultado[] = [];
  for (const escenario of ESCENARIOS) {
    resultados.push(await correrEscenario(escenario));
  }
  return resultados;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultados = await correrOraculo();
  for (const resultado of resultados) {
    const marca = resultado.correcto && resultado.porElCaminoEsperado ? 'ok  ' : 'FALLA';
    process.stdout.write(`${marca} ${resultado.escenario} — ${resultado.detalle}\n`);
  }
  const fallan = resultados.filter((item) => !item.correcto || !item.porElCaminoEsperado);
  process.stdout.write(`\n${resultados.length - fallan.length}/${resultados.length} escenarios medibles\n`);
  if (fallan.length > 0) process.exitCode = 1;
}
