/**
 * Arnés de evaluación del catálogo.
 *
 * Tiene dos modos, y la diferencia importa:
 *
 * - `oracle` (el que corre hoy y el que corre en CI): comprueba que cada
 *   escenario sea realmente medible. Ejecuta los pasos de referencia contra el
 *   servidor MCP con el SDK falso y verifica que la respuesta del servidor
 *   cumpla `check`. Si falla, el escenario está mal escrito o el conjunto de
 *   datos ya no responde la pregunta; medir un modelo con él daría un número
 *   sin sentido. No usa modelos, no cuesta nada y no necesita claves.
 *
 * - `model` (no implementado a propósito): la comparación real entre
 *   perfiles. Necesita un cliente y una clave de un proveedor, y cuesta dinero
 *   por corrida, así que no corre sin la autorización de Veriko. La interfaz
 *   se declara abajo: recibe la pregunta y devuelve el texto final y las
 *   herramientas que llamó.
 */
import { pathToFileURL } from 'node:url';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createFakeApi, loadData, type Call } from './fake-api.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { TOOL_CATALOG } from '../src/catalog.js';
import { createVerikoServer } from '../src/server.js';
import type { Profile, Risk } from '../src/config.js';

export interface Result {
  scenario: string;
  correct: boolean;
  viaExpectedPath: boolean;
  detail: string;
}

function toolNameOf(operationId: string): string {
  const tool = TOOL_CATALOG.find((item) => item.operationId === operationId);
  if (!tool) throw new Error(`el catálogo no tiene la operación ${operationId}`);
  return tool.name;
}

/** Texto plano de lo que devolvió el servidor, que es lo que leería un modelo. */
function textOfResult(result: unknown): string {
  const { content, structuredContent } = result as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
  const prose = (content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return `${prose}\n${JSON.stringify(structuredContent ?? {})}`;
}

function pathMatches(calls: readonly Call[], expected: readonly string[]): boolean {
  return expected.every((method) => calls.some((call) => call.method === method));
}

async function runScenario(scenario: Scenario): Promise<Result> {
  const { client: fake, calls } = createFakeApi(loadData());
  const server = createVerikoServer({
    client: fake,
    config: {
      apiKey: '',
      profiles: new Set<Profile>([scenario.profile as Profile]),
      maxRisk: scenario.risk as Risk,
    },
  });
  const client = new Client(
    { name: 'veriko-evals', version: '1.0.0' },
    scenario.confirms ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (scenario.confirms) {
    const action = scenario.confirms;
    client.setRequestHandler('elicitation/create', async () =>
      action === 'accept' ? { action, content: { confirm: true } } : { action },
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const advertised = (await client.listTools()).tools.map((tool) => tool.name);
    let last: { isError?: boolean } = {};
    let text = '';
    for (const step of scenario.steps) {
      const name = toolNameOf(step.operation);
      if (!advertised.includes(name)) {
        return {
          scenario: scenario.id,
          correct: false,
          viaExpectedPath: false,
          detail: `el perfil ${scenario.profile} no anuncia ${name}`,
        };
      }
      const result = await client.callTool({ name, arguments: step.arguments });
      last = result as { isError?: boolean };
      text = textOfResult(result);
    }

    const errorMatches = Boolean(last.isError) === Boolean(scenario.expectsError);
    return {
      scenario: scenario.id,
      correct: errorMatches && scenario.check(text),
      viaExpectedPath:
        pathMatches(calls, scenario.expectedMethods) &&
        !(scenario.forbiddenMethods ?? []).some((method) => calls.some((call) => call.method === method)),
      detail: text.slice(0, 160).replace(/\s+/g, ' '),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * La interfaz del modo `model`.
 *
 * Un cliente real recibe la pregunta y el catálogo que anuncia un perfil, y
 * devuelve su respuesta final junto con las herramientas que llamó para llegar a ella.
 * Eso puntúa lo que necesita la comparación entre `core`, las familias y `all`:
 * aciertos, llamadas equivocadas, tokens del catálogo y reintentos.
 *
 * Aquí no hay implementación a propósito. Correrla cuesta dinero y necesita
 * una clave de un proveedor; Veriko decide cuándo y con qué clientes.
 */
export interface ModelClient {
  answer(question: string, profile: string): Promise<{ text: string; tools: string[] }>;
}

export async function runOracle(): Promise<readonly Result[]> {
  const results: Result[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runOracle();
  for (const result of results) {
    const mark = result.correct && result.viaExpectedPath ? 'ok  ' : 'FAIL';
    process.stdout.write(`${mark} ${result.scenario}: ${result.detail}\n`);
  }
  const failing = results.filter((item) => !item.correct || !item.viaExpectedPath);
  process.stdout.write(`\n${results.length - failing.length}/${results.length} escenarios medibles\n`);
  if (failing.length > 0) process.exitCode = 1;
}
