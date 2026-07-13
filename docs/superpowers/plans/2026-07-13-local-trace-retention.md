# Local Trace Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each Loop run in a separate local JSONL file, retain only the newest 20 run files, and disable all Agents SDK trace uploads.

**Architecture:** A trace factory derives a unique run path from the configured `tracePath`, creates the current file, and prunes older matching files. Application assembly disables the Agents SDK global trace provider before constructing the runner; the local `JsonlTraceWriter` remains independent.

**Tech Stack:** TypeScript, Node.js filesystem APIs, OpenAI Agents SDK, Node test runner.

## Global Constraints

- Preserve the user's uncommitted `config/loop.config.json` changes.
- Keep `.gitkeep` and unrelated files during retention cleanup.
- Count partial or interrupted run files toward the 20-file limit.
- Never expose API keys in tests, logs, or traces.
- Add learning-oriented comments around retention ordering and global versus local tracing.
- Use TDD: observe each relevant test fail before writing production code.

---

### Task 1: One Trace File Per Run With 20-File Retention

**Files:**
- Create: `src/trace/create-run-trace-writer.ts`
- Modify: `src/cli.ts`
- Create: `tests/unit/run-trace-writer.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: configured base path such as `traces/loop.jsonl`, retention limit, and optional clock.
- Produces: `createRunTraceWriter(options): Promise<{ writer: JsonlTraceWriter; tracePath: string }>`.

- [ ] **Step 1: Write failing retention tests**

```ts
test("creates a timestamped file from the configured base path", async () => {
  const result = await createRunTraceWriter({
    basePath: join(directory, "loop.jsonl"),
    maxFiles: 20,
    now: () => new Date("2026-07-13T08:30:00.123Z"),
  });
  assert.equal(basename(result.tracePath), "loop-2026-07-13T08-30-00-123Z.jsonl");
});

test("keeps only the newest 20 matching trace files", async () => {
  await createTwentyOneOldTraceFiles(directory);
  await createRunTraceWriter({ basePath: join(directory, "loop.jsonl"), maxFiles: 20 });
  assert.equal((await matchingTraceFiles(directory)).length, 20);
  assert.equal(await exists(join(directory, ".gitkeep")), true);
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `./node_modules/.bin/tsx --test tests/unit/run-trace-writer.test.ts`
Expected: FAIL because `create-run-trace-writer.ts` does not exist.

- [ ] **Step 3: Implement trace creation and retention**

```ts
export async function createRunTraceWriter(options: CreateRunTraceWriterOptions) {
  const directory = dirname(options.basePath);
  const extension = extname(options.basePath);
  const prefix = basename(options.basePath, extension);
  const timestamp = (options.now?.() ?? new Date()).toISOString().replaceAll(":", "-").replace(".", "-");
  const tracePath = join(directory, `${prefix}-${timestamp}${extension}`);

  await mkdir(directory, { recursive: true });
  await writeFile(tracePath, "", { flag: "wx" });
  await pruneTraceFiles({ directory, prefix, extension, maxFiles: options.maxFiles });

  return { writer: new JsonlTraceWriter(tracePath), tracePath };
}
```

Sort matching files by modification time descending and delete entries after index 19. Only names matching `${prefix}-*.jsonl` participate.

- [ ] **Step 4: Connect the factory and verify green**

Replace direct `new JsonlTraceWriter(...)` construction in `src/cli.ts` with `await createRunTraceWriter(...)`. Run:

```bash
./node_modules/.bin/tsx --test tests/unit/run-trace-writer.test.ts
npm test
npm run build
```

Expected: retention tests and all regressions PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/trace/create-run-trace-writer.ts src/cli.ts tests/unit/run-trace-writer.test.ts README.md
git commit -m "feat: retain latest local loop traces"
```

---

### Task 2: Disable Agents SDK Global Trace Upload

**Files:**
- Create: `src/agents/disable-sdk-tracing.ts`
- Modify: `src/cli.ts`
- Create: `tests/unit/disable-sdk-tracing.test.ts`

**Interfaces:**
- Produces: `disableSdkTracing(setDisabled = setTracingDisabled): void`.
- The injectable function exists only to verify the boundary without inspecting SDK private global state.

- [ ] **Step 1: Write the failing global-disable test**

```ts
test("disables the Agents SDK global trace provider", () => {
  const calls: boolean[] = [];
  disableSdkTracing((disabled) => calls.push(disabled));
  assert.deepEqual(calls, [true]);
});
```

- [ ] **Step 2: Run test and verify red**

Run: `./node_modules/.bin/tsx --test tests/unit/disable-sdk-tracing.test.ts`
Expected: FAIL because `disable-sdk-tracing.ts` does not exist.

- [ ] **Step 3: Implement and call the global disable boundary**

```ts
import { setTracingDisabled } from "@openai/agents";

export function disableSdkTracing(
  setDisabled: (disabled: boolean) => void = setTracingDisabled,
): void {
  setDisabled(true);
}
```

Call `disableSdkTracing()` at the beginning of `runConfiguredLoop`, before runner creation. Keep `Runner({ tracingDisabled: true })` as defense in depth for model-level tracing.

- [ ] **Step 4: Verify all behavior**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/disable-sdk-tracing.test.ts
npm test
npm run build
npm run test:integration
```

Expected: all unit tests PASS, build succeeds, and the live integration test safely skips without its opt-in flag.

- [ ] **Step 5: Commit**

```bash
git add src/agents/disable-sdk-tracing.ts src/cli.ts tests/unit/disable-sdk-tracing.test.ts
git commit -m "fix: disable sdk trace uploads"
```

---

## Final Verification

- [ ] Confirm `git status --short` contains only the user's existing configuration edit.
- [ ] Run `npm test` and `npm run build`.
- [ ] Run a local test command with a configured key and confirm no `[non-fatal] Tracing` upload warning appears.
- [ ] Confirm the new run creates a timestamped JSONL file and the directory contains at most 20 matching run files.
