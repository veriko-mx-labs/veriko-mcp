# Catalog evals

Eighteen scenarios to decide with data which profile fits by default, instead of
fixing it by preference. They cover reads (`E*`), writes and asynchronous flows
(`W*`) and error results (`X*`).

## What it measures today

`npm run evals` runs the **oracle**: for each scenario it executes the reference
steps against the MCP server with a fake SDK, and checks that the response
satisfies the scenario's rule and that the error flag matches `expectsError`.

This does not evaluate any model. It checks that the scenarios **are
measurable**: the data set still answers the question, the operation keeps its
shape and the correctness rule still decides. A broken scenario would give a
meaningless number when comparing profiles, and it is the failure mode nobody
notices. For that reason it also runs in the suite (`test/evals.test.ts`).

It uses no models, costs nothing and needs no keys.

## Current limitations

The real comparison between `core`, the families and `all` (hits, wrong calls,
catalog tokens and retries) needs a client and a provider key, and costs money
per run. The interface is declared in `ModelClient`, inside `runner.ts`; the
decision to run it belongs to Veriko.

The context cost of each profile, the other half of that comparison, is already
measured with `npm run measure:catalog`.

## Scenario rules

- **No real quota.** All of them run against `fake-api.ts`, so a run against a
  real model spends no validations. Write scenarios (`W*`) and error scenarios
  (`X*`) use the same fake.
- **Confirmation.** A scenario with `confirms` runs with a client that declares
  the elicitation capability and answers the confirmation question of a
  destructive tool with that action. `forbiddenMethods` lists the SDK calls the
  path must not make, for example a delete the person declined.
- **Independent.** None depends on another; they run in any order.
- **Checkable.** `check` decides with a rule, not with a similarity judgment.
- **With an expected path.** The path is measured too: a right answer through
  the wrong tool is a fragile right answer.

## The data

`data.json` is fictitious and versioned next to the scenarios, so a run today and
one in six months start from the same place. No figure, account, tracking key
or name comes from a production response. The real API is never touched.
