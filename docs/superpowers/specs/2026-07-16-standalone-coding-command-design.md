# Standalone Coding Command Design

## Goal

Replace the public coding invocation
`npm run loop -- coding "<request>"` with
`npm run coding -- "<request>"`. The old coding subcommand is intentionally not
kept for compatibility. The ordinary `npm run loop -- "<task>"` behavior remains
unchanged.

## Design

- Add `src/coding-cli.ts` as the dedicated coding-mode process entry point. It
  parses all CLI arguments as one natural-language request, calls
  `runConfiguredCodingMode`, prints the existing structured result, and preserves
  the current exit-code rule: only `failed` sets exit code 1.
- Add `"coding": "tsx src/coding-cli.ts"` to `package.json`.
- Simplify `src/cli.ts` so it only parses and runs ordinary loop tasks. The token
  `coding` has no special meaning there, so the former command cannot enter coding
  mode.
- Update README examples and descriptions to present the standalone command as
  the only coding-mode entry point.

## Failure Handling

An empty standalone coding request fails before runtime construction with
`Usage: npm run coding -- "your request"`. Runtime failures continue to use the
existing top-level error handling and structured coding result contract.

## Testing

- Add a focused unit test for standalone coding argument parsing, including the
  empty-request usage error.
- Update CLI routing tests to prove the ordinary loop parser no longer selects a
  coding mode.
- Run the focused tests, the full offline unit suite, and the TypeScript build.
