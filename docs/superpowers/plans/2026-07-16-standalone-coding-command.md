# Standalone Coding Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run coding -- "<request>"` the only coding-mode command while preserving the ordinary loop command.

**Architecture:** A dedicated `src/coding-cli.ts` entry point owns coding argument parsing and configured coding-mode execution. `src/cli.ts` becomes loop-only, so the old `loop -- coding` form has no coding-specific routing.

**Tech Stack:** TypeScript 7, Node.js 22+, tsx, node:test, npm scripts.

## Global Constraints

- Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons.
- Add detailed Chinese comments around important logic.
- Do not retain the old coding subcommand compatibility path.
- Preserve `npm run loop -- "<task>"` behavior.
- Do not create a Git commit unless the user explicitly requests one.

---

### Task 1: Replace the coding subcommand with a standalone npm command

**Files:**
- Create: `src/coding-cli.ts`
- Create: `tests/unit/coding-cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/unit/cli-mode.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runConfiguredCodingMode(request: string): Promise<CodingRunResult>`.
- Produces: `parseCodingRequest(args: string[]): string` and npm script `coding`.

- [x] **Step 1: Change the loop-routing test first**

Update `tests/unit/cli-mode.test.ts` so `parseCliInvocation(["coding", "request"])`
must return `{ mode: "loop", request: "coding request" }`, and empty loop input still
throws `Usage: npm run loop -- "your task"`.

- [x] **Step 2: Run the loop-routing test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/cli-mode.test.ts`

Expected: FAIL because the current parser still returns `mode: "coding"`.

- [x] **Step 3: Make the ordinary CLI loop-only**

Remove the coding import, coding union member, and coding execution branch from
`src/cli.ts`. Join every argument into the loop request and retain the ordinary usage
error.

- [x] **Step 4: Run the loop-routing test and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/cli-mode.test.ts`

Expected: PASS.

- [x] **Step 5: Write the standalone coding parser test**

Create `tests/unit/coding-cli.test.ts` with tests that expect:

```ts
parseCodingRequest(["帮我查看", "loop 模块代码"])
// => "帮我查看 loop 模块代码"

parseCodingRequest([])
// throws /Usage: npm run coding -- "your request"/
```

- [x] **Step 6: Run the standalone parser test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/coding-cli.test.ts`

Expected: FAIL because `src/coding-cli.ts` does not exist.

- [x] **Step 7: Implement the standalone coding entry point**

Create `src/coding-cli.ts` with exported `parseCodingRequest`, a private `main` that
calls `runConfiguredCodingMode`, JSON output, the existing `failed` exit-code rule,
direct-execution detection, and top-level error handling using the `Coding failed:`
prefix.

- [x] **Step 8: Add the npm script and verify the focused tests**

Add `"coding": "tsx src/coding-cli.ts"` to `package.json`, then run:

```bash
./node_modules/.bin/tsx --test tests/unit/cli-mode.test.ts tests/unit/coding-cli.test.ts
```

Expected: PASS.

- [x] **Step 9: Update user-facing documentation**

Change the README Coding mode introduction and all four examples to use
`npm run coding -- "..."`. Do not advertise the old command.

- [x] **Step 10: Run regression verification**

Run `npm test` and `npm run build`.

Expected: all offline unit tests pass and TypeScript compilation exits with code 0.
