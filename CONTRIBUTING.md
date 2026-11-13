# Contributing

Issues and pull requests are welcome.

## Report a bug or request a change

Open an issue with the [bug report](https://github.com/veriko-mx-labs/veriko-mcp/issues/new?template=bug_report.yml) or [feature request](https://github.com/veriko-mx-labs/veriko-mcp/issues/new?template=feature_request.yml) form. Search the open issues first.

A bug report needs the versions you use, the steps that reproduce it and, when the API answered with an error, its `request_id` (the `request_id` field of the tool result). Remove API keys, receipts, account numbers and customer data from anything you paste.

Do not open a public issue for a security vulnerability. Follow [SECURITY.md](SECURITY.md).

## Propose a change

1. For anything larger than a fix, open an issue first so the change can be agreed before you write it.
2. Fork the repository and create a branch from `main`.
3. Make the change. Add or update the tests in `test/`.
4. Run the checks of this repository:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm run check:surface
   ```

   `npm test` uses a fake API and never reaches the real one. `npm run evals` runs the scenarios in `evals/`. Use Node.js 20 or later.

5. Update README.md and CHANGELOG.md when the behavior that users see changes.
6. Open a pull request against `main` and fill in the template.

Write commit messages in English, in the imperative, and keep one change in each commit.

The server reaches the API only through the official JavaScript SDK. Do not add HTTP code to a tool. `npm run check:surface` compares the tools with the public surface of the spec.

When a tool or a profile changes, update the README. `npm run measure:catalog` regenerates the cost per profile.

## The API contract

The API contract is the public spec at <https://docs.veriko.mx/openapi.yaml>. `spec/openapi.yaml` is a copy that a scheduled workflow syncs. Do not edit it by hand. When the API behaves differently from the spec, open an issue.
