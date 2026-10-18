# Contributing

Thanks for taking a look. Issues and pull requests are welcome; for anything
larger than a fix, please open an issue first so we can agree on the approach.

## Requirements

- Node.js 22.18 or newer (the example servers, test fixtures and scripts run as
  TypeScript through Node's built-in type stripping, and tsup 9 needs it). CI
  runs Node 22.18.0, the latest 22 and the latest 24.
- npm 10 or newer.

## Setup

```sh
npm ci          # installs dependencies and builds dist/ via the prepare script
```

## Everyday commands

| Command                                   | What it does                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm test`                                | Runs the whole test suite (unit, integration, end-to-end).                          |
| `npm run coverage`                        | Runs the tests with v8 coverage and enforces the thresholds in `vitest.config.ts`.  |
| `npm run lint`                            | ESLint with typescript-eslint `strictTypeChecked`; warnings fail.                   |
| `npm run typecheck`                       | `tsc --noEmit` over sources, tests, examples and scripts.                           |
| `npm run format` / `npm run format:check` | Prettier.                                                                           |
| `npm run build`                           | tsup: ESM bundle and declarations in `dist/`.                                       |
| `npm run examples`                        | Runs the documented example workflow with the built CLI and checks every exit code. |
| `npm run bench`                           | Micro-benchmarks for the diff engine.                                               |
| `npm run ci`                              | Everything CI runs, in the same order.                                              |

The property-based soundness test runs 400 cases by default. For a longer
search, raise the run count and vary the seed:

```sh
MCP_CONTRACT_FC_RUNS=20000 MCP_CONTRACT_FC_SEED=7 npx vitest run test/property --testTimeout=0
```

## Project layout

```text
src/connect/     connecting, protocol negotiation, child-process lifecycle
src/snapshot/    capture (pagination), canonical format, files
src/diff/        snapshot rules and the JSON Schema engine (src/diff/schema/)
src/scenarios/   scenario files, selectors, matchers, runner
src/report/      text, JSON, Markdown and GitHub output
src/cli/         the CLI as a pure function of argv and injected I/O
test/            unit, integration (in-memory servers), e2e (real processes), property
examples/        the notes server (v1, v2), baseline snapshot and scenarios
docs/adr/        design decisions
```

## Adding or changing a compatibility rule

1. Add a `ChangeCode` in `src/diff/model.ts` if the change is a new kind.
2. Implement the rule in `src/diff/schema/` (schema keywords) or
   `src/diff/snapshot-diff.ts` (tools, prompts, resources, server).
3. Add rows to the rule table in `test/unit/schema-diff.test.ts` (both
   directions) or to `test/unit/snapshot-diff.test.ts`.
4. If the rule can produce `non-breaking`, make sure the property test's
   generators can reach it, and run a long search.
5. Explain the rule in the README table and, if it is a new assumption, in
   `docs/adr/0002-compatibility-rules.md`.

## Commits

Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`), one
logical change per commit, with the tests for a change in the same commit.
Every pull request must pass `npm run ci`, and each commit should pass it on
its own. (The first commits of this repository predate that rule: some of
them do not build on their own, and their tests arrived in later commits.)
