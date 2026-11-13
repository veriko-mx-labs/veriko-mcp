/**
 * Evaluation harness for the catalog.
 *
 * It has two modes, and the difference matters:
 *
 * - `oracle` (the one that runs today, and the one that runs in CI): checks
 *   that every scenario is actually measurable. It runs the reference steps
 *   against the MCP server with the fake SDK and verifies that the server's
 *   response satisfies `check`. If this fails, the scenario is badly written or
 *   the data set no longer answers the question; measuring a model with it
 *   would give a meaningless number. It uses no models, costs nothing and needs
 *   no keys.
 *
 * - `model` (deliberately not implemented): the real comparison between
 *   profiles. It needs a client and a provider key, and costs money per run, so
 *   it does not run without Veriko's authorization. The interface is declared
 *   below: it receives the question and returns the final text and the tools it
 *   called.
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
  if (!tool) throw new Error(`the catalog has no operation ${operationId}`);
  return tool.name;
}

/** Plain text of what the server returned, which is what a model would read. */
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
          detail: `the ${scenario.profile} profile does not advertise ${name}`,
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
 * The interface of the `model` mode.
 *
 * A real client receives the question and the catalog a profile advertises, and
 * returns its final answer together with the tools it called to get there.
 * That scores what the comparison between `core`, the families and `all` needs:
 * hits, wrong calls, catalog tokens and retries.
 *
 * There is no implementation here on purpose. Running it costs money and needs
 * a provider key; Veriko decides when and with which clients.
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
  process.stdout.write(`\n${results.length - failing.length}/${results.length} measurable scenarios\n`);
  if (failing.length > 0) process.exitCode = 1;
}
