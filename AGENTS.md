# Repository Guidelines

## Project Structure & Module Organization

`src/cli.ts` is the composition root. Domain types live in `src/domain/`, loop orchestration in `src/loop/`, model setup in `src/agents/`, configuration in `src/config/`, and JSONL tracing in `src/trace/`. Stage implementations are under `src/loop/stages/`. Unit tests belong in `tests/unit/`; opt-in API tests belong in `tests/integration/`. Runtime configuration is stored in `config/loop.config.json`; generated output goes to `dist/` and local traces to `traces/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 22 or newer is required.
- `npm run loop -- "任务描述"`: run the configured loop locally.
- `npm test`: run offline unit tests with `tsx` and Node's test runner.
- `npm run build`: type-check and compile TypeScript into `dist/`.
- `npm run test:integration`: run integration tests; live API work is skipped by default.
- `RUN_LIVE_LOOP=1 npm run test:integration`: perform the paid, credentialed live check.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons. Prefer `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames such as `create-run-trace-writer.ts`. Keep domain code provider-neutral and isolate filesystem or SDK concerns in adapters. No formatter or linter is configured, so match surrounding code and verify with `npm run build`.

This is a learning project. Add detailed Chinese comments around important logic. Explain design intent, data flow, failure handling, and boundary conditions; do not merely restate each line. Keep established technical terms such as `LoopStep`, Agent, trace, JSONL, SDK, and API when they improve precision.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `<subject>.test.ts`. Put deterministic behavior in unit tests and network-dependent behavior in integration tests. Cover success paths, invalid input, failures, and safety limits. Run unit tests and the build before submitting; run the live integration check only when credentials and paid API usage are intended.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat:`, `fix:`, `docs:`, and `chore:`. Use an imperative, specific subject, for example `docs: add contributor guidelines`. Pull requests should explain motivation and behavior, list verification commands, link related issues, and call out configuration or API-cost effects. Include screenshots only for visual changes. Keep generated files, traces, and secrets out of commits.

## Security & Configuration Tips

Store credentials only in the ignored `.env` file. Never place real keys in config, tests, traces, logs, or commit history. Treat trace data as potentially sensitive before sharing it.
