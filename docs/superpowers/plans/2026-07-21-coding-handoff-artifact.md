# Coding Handoff Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically write a concise, actionable `handoff.md` at the workspace root after every Coding mode terminal state.

**Architecture:** Build a provider-neutral `HandoffArtifact` from the Coding result and frozen trace, render it with a pure Markdown formatter, and persist it through an atomic same-directory rename. A thin Coding-mode wrapper connects this pipeline to `runConfiguredCodingMode` without adding handoff concerns to the classifier, executor, reviewer, or generic workflow runner.

**Tech Stack:** TypeScript 7, Node.js 22 ESM APIs, `node:test`, `node:assert/strict`

## Global Constraints

- The feature applies only to Coding mode.
- Generate `handoff.md` for `completed`, `failed`, `blocked`, and `cancelled` terminal states.
- Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons.
- Add detailed Chinese comments around important logic, design intent, failure handling, and boundary conditions.
- Do not add a model call or a new runtime dependency.
- Do not copy raw prompts, environment variables, shell stdout/stderr, complete trace events, or complete model responses into the handoff.
- Keep Goal and final output at 2,000 characters; Completed Steps at 10 items; Open Questions at 5 items; Evidence at 10 items of 300 characters; Failed Attempts at 5 items of 300 characters; Next Recommended Action at 500 characters.
- Append `… [truncated]` whenever text is shortened.
- Persist with a same-directory temporary file followed by atomic `rename`; a failed write must preserve the previous complete `handoff.md`.
- Run offline unit tests and `npm run build` before completion.

---

## File Structure

- Create `src/handoff/handoff-artifact.ts`: provider-neutral artifact interfaces and fixed limits.
- Create `src/handoff/build-coding-handoff-artifact.ts`: pure trace/result extraction, compaction, deduplication, redaction, and next-action rules.
- Create `src/handoff/render-handoff-markdown.ts`: pure seven-section Markdown renderer.
- Create `src/handoff/write-handoff-file.ts`: atomic same-directory file replacement.
- Create `src/handoff/generate-coding-handoff.ts`: compose builder, renderer, and writer for one terminal Coding run.
- Create `src/modes/coding/run-coding-mode-with-handoff.ts`: thin orchestration boundary that guarantees generation after a terminal result.
- Modify `src/modes/coding/run-configured-coding-mode.ts`: route the configured run through the handoff wrapper and use the configured workspace root.
- Create `tests/unit/handoff-artifact.test.ts`: builder and safety behavior.
- Create `tests/unit/handoff-markdown.test.ts`: stable Markdown contract.
- Create `tests/unit/handoff-file.test.ts`: atomic replacement and failure preservation.
- Create `tests/unit/coding-handoff-integration.test.ts`: all-terminal wrapper integration without API calls.
- Modify `README.md`: document automatic generation and the artifact/audit boundary.

### Task 1: Build the Structured Handoff Artifact

**Files:**
- Create: `src/handoff/handoff-artifact.ts`
- Create: `src/handoff/build-coding-handoff-artifact.ts`
- Test: `tests/unit/handoff-artifact.test.ts`

**Interfaces:**
- Consumes: `CodingRunResult` from `src/modes/coding/coding-state.ts` and `readonly TraceEvent[]` from `src/trace/trace-event.ts`.
- Produces: `buildCodingHandoffArtifact(input: { request: string; result: CodingRunResult; trace: readonly TraceEvent[] }): HandoffArtifact`.
- Produces: `HANDOFF_LIMITS`, `HandoffArtifact`, `HandoffCompletedStep`, `HandoffEvidence`, and `HandoffFailedAttempt`.

- [ ] **Step 1: Write failing builder tests for terminal-state extraction**

Create `tests/unit/handoff-artifact.test.ts` with table-driven cases for completed, blocked, failed, and cancelled results. Use real `TraceEvent` values, including accepted evidence, a reviewer revise event, a `tool_failed` event, and a `workflow_step_failed` event. The core assertions must be:

```typescript
const artifact = buildCodingHandoffArtifact({ request, result, trace });

assert.equal(artifact.goal, request);
assert.equal(artifact.currentState.status, result.status);
assert.equal(artifact.currentState.stopReason, result.stopReason);
assert.deepEqual(artifact.openQuestions, ["May I inspect the protected fixture?"]);
assert.equal(artifact.failedAttempts[0]?.kind, "tool:shell/execute");
assert.equal(
  artifact.nextRecommendedAction,
  "Answer the first open question, then rerun the Coding task.",
);
```

Also assert that completed steps preserve first-completion order, evidence is deduplicated by `kind + source + summary`, and final accepted workflow evidence precedes earlier evidence.

- [ ] **Step 2: Run the builder test and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-artifact.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `build-coding-handoff-artifact.js`.

- [ ] **Step 3: Add the artifact contract and limits**

Create `src/handoff/handoff-artifact.ts`:

```typescript
import type { WorkflowStatus } from "../runtime/workflow-types.js";
import type { CodingStopReason } from "../modes/coding/coding-state.js";
import type { CodingTaskType } from "../modes/coding/coding-task.js";

export const HANDOFF_LIMITS = {
  goalChars: 2_000,
  finalOutputChars: 2_000,
  completedSteps: 10,
  openQuestions: 5,
  evidence: 10,
  evidenceChars: 300,
  failedAttempts: 5,
  failedAttemptChars: 300,
  nextActionChars: 500,
} as const;

export interface HandoffCompletedStep {
  step: string;
  evidence: string[];
}

export interface HandoffEvidence {
  kind: string;
  source: string;
  summary: string;
}

export interface HandoffFailedAttempt {
  kind: string;
  summary: string;
  suggestedNextStep: string | null;
}

export interface HandoffArtifact {
  goal: string;
  currentState: {
    status: WorkflowStatus;
    taskType: CodingTaskType | null;
    stopReason: CodingStopReason;
    completedSteps: number;
    finalOutput: string | null;
    tracePath: string;
  };
  completedSteps: HandoffCompletedStep[];
  openQuestions: string[];
  evidence: HandoffEvidence[];
  failedAttempts: HandoffFailedAttempt[];
  nextRecommendedAction: string;
}
```

- [ ] **Step 4: Implement the minimal pure builder**

Create `src/handoff/build-coding-handoff-artifact.ts`. Implement focused helpers with these exact responsibilities:

```typescript
export function compactText(value: string, maxChars: number): string;
function redactSensitiveText(value: string): string;
function collectCompletedSteps(trace: readonly TraceEvent[]): HandoffCompletedStep[];
function collectEvidence(trace: readonly TraceEvent[]): HandoffEvidence[];
function collectFailedAttempts(
  trace: readonly TraceEvent[],
  result: CodingRunResult,
): HandoffFailedAttempt[];
function createNextRecommendedAction(
  result: CodingRunResult,
  openQuestions: readonly string[],
  failedAttempts: readonly HandoffFailedAttempt[],
): string;
export function buildCodingHandoffArtifact(input: {
  request: string;
  result: CodingRunResult;
  trace: readonly TraceEvent[];
}): HandoffArtifact;
```

`compactText` must collapse whitespace, redact credential-shaped values, reserve space for `… [truncated]`, and never exceed `maxChars`. Redact at least `sk-...` tokens and assignments whose names end in `API_KEY`, `TOKEN`, `SECRET`, or `PASSWORD`.

Collect only `workflow_step_completed.evidence`; iterate those events from newest to oldest for evidence priority, deduplicate, then reverse only where presentation order requires it. Extract failed attempts from `tool_failed`, `workflow_step_failed`, and `subagent_finished`. For a completed reviewer with `extensions.decision === "revise"`, safely narrow the JSON extension at runtime and use its string `revisionInstructions`. For an unsuccessful reviewer, use its normalized `summary` and `errors`; never serialize the whole result.

If the result is failed/blocked and no event yielded a failed attempt, synthesize one from `result.stopReason` so the handoff never hides the terminal problem.

- [ ] **Step 5: Verify GREEN, then add compaction and safety tests**

Run the focused test until it passes. Then add cases proving:

```typescript
assert.ok(artifact.goal.length <= HANDOFF_LIMITS.goalChars);
assert.match(artifact.goal, /… \[truncated\]$/);
assert.doesNotMatch(JSON.stringify(artifact), /sk-test-secret-value/);
assert.doesNotMatch(JSON.stringify(artifact), /OPENAI_API_KEY=my-secret/);
assert.equal(artifact.evidence.length, HANDOFF_LIMITS.evidence);
assert.equal(artifact.failedAttempts.length, HANDOFF_LIMITS.failedAttempts);
```

Re-run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-artifact.test.ts
```

Expected: PASS with no warnings.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/handoff/handoff-artifact.ts src/handoff/build-coding-handoff-artifact.ts tests/unit/handoff-artifact.test.ts
git commit -m "feat: build coding handoff artifact"
```

### Task 2: Render the Stable Seven-Section Markdown Contract

**Files:**
- Create: `src/handoff/render-handoff-markdown.ts`
- Test: `tests/unit/handoff-markdown.test.ts`

**Interfaces:**
- Consumes: `HandoffArtifact` from Task 1.
- Produces: `renderHandoffMarkdown(artifact: HandoffArtifact): string`.

- [ ] **Step 1: Write the failing renderer test**

Create `tests/unit/handoff-markdown.test.ts` with a complete artifact fixture. Assert exact heading order and representative list formatting:

```typescript
const markdown = renderHandoffMarkdown(artifact);
const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

assert.deepEqual(headings, [
  "Goal",
  "Current State",
  "Completed Steps",
  "Open Questions",
  "Evidence",
  "Failed Attempts",
  "Next Recommended Action",
]);
assert.match(markdown, /- Status: `blocked`/);
assert.match(markdown, /- `file` — `src\/cli\.ts`: Entry point inspected\./);
assert.ok(markdown.endsWith("\n"));
```

Add a second fixture with empty arrays and `finalOutput: null`; assert each relevant section contains `None recorded.` and no heading disappears.

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-markdown.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `render-handoff-markdown.js`.

- [ ] **Step 3: Implement the renderer**

Create `src/handoff/render-handoff-markdown.ts`. Use only the artifact fields; do not inspect trace events or perform file I/O. Escape inline backticks in dynamic labels and render the following stable shape:

```markdown
# Task Handoff

## Goal

<goal>

## Current State

- Status: `<status>`
- Task type: `<taskType or none>`
- Stop reason: `<stopReason>`
- Completed workflow steps: <number>
- Trace: `<tracePath>`

<final output or None recorded.>

## Completed Steps

- `<step>` — <joined evidence or Completed without recorded evidence.>

## Open Questions

- <question>

## Evidence

- `<kind>` — `<source>`: <summary>

## Failed Attempts

- `<kind>`: <summary> Next: <suggested next step>

## Next Recommended Action

<next action>
```

- [ ] **Step 4: Verify GREEN and the full builder/renderer slice**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-artifact.test.ts tests/unit/handoff-markdown.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/handoff/render-handoff-markdown.ts tests/unit/handoff-markdown.test.ts
git commit -m "feat: render coding handoff markdown"
```

### Task 3: Persist Handoff Atomically

**Files:**
- Create: `src/handoff/write-handoff-file.ts`
- Create: `src/handoff/generate-coding-handoff.ts`
- Test: `tests/unit/handoff-file.test.ts`

**Interfaces:**
- Produces: `writeHandoffFile(input: { handoffPath: string; markdown: string; fileSystem?: HandoffFileSystem; createId?: () => string }): Promise<void>`.
- Produces: `generateCodingHandoff(input: { request: string; result: CodingRunResult; trace: readonly TraceEvent[]; workspaceRoot: string; writer?: typeof writeHandoffFile }): Promise<string>` returning the absolute handoff path.

- [ ] **Step 1: Write failing atomic-writer tests**

Create `tests/unit/handoff-file.test.ts`. Use `mkdtemp(join(tmpdir(), "coding-handoff-"))` for the success case and a small injected file-system adapter for failures. Assert:

```typescript
await writeFile(handoffPath, "old handoff\n", "utf8");
await writeHandoffFile({ handoffPath, markdown: "new handoff\n" });
assert.equal(await readFile(handoffPath, "utf8"), "new handoff\n");

await assert.rejects(
  writeHandoffFile({ handoffPath, markdown: "partial", fileSystem: failingFs }),
  /Failed to write handoff artifact/,
);
assert.equal(await readFile(handoffPath, "utf8"), "old handoff\n");
```

Also assert no `.handoff.md.*.tmp` file remains after an injected rename failure, and test `generateCodingHandoff` returns `join(workspaceRoot, "handoff.md")` with rendered content.

- [ ] **Step 2: Run the writer test and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-file.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `write-handoff-file.js`.

- [ ] **Step 3: Implement atomic replacement with injectable file operations**

Create `src/handoff/write-handoff-file.ts` with this boundary:

```typescript
export interface HandoffFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}
```

The implementation must create `.handoff.md.${createId()}.tmp` in `dirname(handoffPath)`, write the complete Markdown using `flag: "wx"`, and rename only after the write resolves. In `catch`, attempt `rm(tempPath, { force: true })`, ignore only that cleanup error, and throw an `Error` whose message is `Failed to write handoff artifact: ${handoffPath}` and whose `cause` is the original failure.

- [ ] **Step 4: Implement the pipeline composer**

Create `src/handoff/generate-coding-handoff.ts`:

```typescript
export async function generateCodingHandoff(input: {
  request: string;
  result: CodingRunResult;
  trace: readonly TraceEvent[];
  workspaceRoot: string;
  writer?: typeof writeHandoffFile;
}): Promise<string> {
  const handoffPath = join(input.workspaceRoot, "handoff.md");
  const artifact = buildCodingHandoffArtifact(input);
  const markdown = renderHandoffMarkdown(artifact);
  await (input.writer ?? writeHandoffFile)({ handoffPath, markdown });
  return handoffPath;
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/handoff-file.test.ts
```

Expected: all tests PASS; the failure test preserves the old file and removes the temporary file.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/handoff/write-handoff-file.ts src/handoff/generate-coding-handoff.ts tests/unit/handoff-file.test.ts
git commit -m "feat: write handoff artifact atomically"
```

### Task 4: Connect Every Coding Terminal State and Document the Feature

**Files:**
- Create: `src/modes/coding/run-coding-mode-with-handoff.ts`
- Modify: `src/modes/coding/run-configured-coding-mode.ts`
- Create: `tests/unit/coding-handoff-integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `generateCodingHandoff` from Task 3 and the existing `CodingRunResult`.
- Produces: `runCodingModeWithHandoff(input: { request: string; workspaceRoot: string; run: () => Promise<CodingRunResult>; traceSnapshot: () => readonly TraceEvent[]; generate?: typeof generateCodingHandoff }): Promise<CodingRunResult>`.
- Preserves: the public `runConfiguredCodingMode(request, configPath?)` return type and JSON output contract.

- [ ] **Step 1: Write the failing all-terminal integration test**

Create `tests/unit/coding-handoff-integration.test.ts`. For every status in `completed`, `failed`, `blocked`, and `cancelled`, inject a fake `run` and `generate`:

```typescript
for (const status of ["completed", "failed", "blocked", "cancelled"] as const) {
  await t.test(status, async () => {
    const calls: unknown[] = [];
    const result = createResult(status);

    const returned = await runCodingModeWithHandoff({
      request: "Continue the task",
      workspaceRoot: "/workspace",
      run: async () => result,
      traceSnapshot: () => trace,
      generate: async (input) => {
        calls.push(input);
        return "/workspace/handoff.md";
      },
    });

    assert.equal(returned, result);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      request: "Continue the task",
      workspaceRoot: "/workspace",
      result,
      trace,
    });
  });
}
```

Add a failure case asserting a rejected `generate` causes the wrapper to reject instead of returning an apparently successful result.

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-handoff-integration.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `run-coding-mode-with-handoff.js`.

- [ ] **Step 3: Implement the terminal wrapper**

Create `src/modes/coding/run-coding-mode-with-handoff.ts`:

```typescript
export async function runCodingModeWithHandoff(input: {
  request: string;
  workspaceRoot: string;
  run: () => Promise<CodingRunResult>;
  traceSnapshot: () => readonly TraceEvent[];
  generate?: typeof generateCodingHandoff;
}): Promise<CodingRunResult> {
  const result = await input.run();
  const trace = input.traceSnapshot();
  await (input.generate ?? generateCodingHandoff)({
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    result,
    trace,
  });
  return result;
}
```

This wrapper intentionally runs generation only after `run()` resolves with a terminal result. A thrown runtime/trace exception before a terminal result must remain an exception and must not overwrite the previous handoff with an invented state.

- [ ] **Step 4: Route configured Coding mode through the wrapper**

In `src/modes/coding/run-configured-coding-mode.ts`, import the wrapper and retain the general tool runtime before deriving Coding tool restrictions:

```typescript
import { runCodingModeWithHandoff } from "./run-coding-mode-with-handoff.js";

const workspaceRuntime = createToolRuntimeConfig(loaded.config, process.cwd());
const toolRuntime = createCodingToolRuntimeConfig(workspaceRuntime);
```

Replace the direct `return runCodingMode({...})` with:

```typescript
return runCodingModeWithHandoff({
  request,
  workspaceRoot: workspaceRuntime.workspaceRoot,
  traceSnapshot: () => traceJournal.snapshot(),
  run: () => runCodingMode({
    request,
    activeModel: loaded.activeModelName,
    tracePath,
    maxSteps: loaded.config.safetyLimits.maxSteps,
    traceWriter: traceJournal,
    traceSnapshot: () => traceJournal.snapshot(),
    now,
    classifier: (rawRequest) =>
      classifyCodingRequest(runner, classifierAgent, rawRequest, maxTurns),
    executor: ({
      request: rawRequest,
      classification,
      instructions,
      revisionInstructions,
    }) => {
      const prompt = createCodingExecutorPrompt({
        request: rawRequest,
        objective: classification.objective,
        classificationReason: classification.reason,
        workflowInstructions: instructions,
        revisionInstructions,
      });

      return runCodingAgent({
        runner,
        agent: codingAgent,
        prompt,
        maxTurns,
        traceWriter: traceJournal,
        now,
      });
    },
    reviewer: async ({ attempt, trace, summary }) => {
      const contract = createReviewerAgentContract({
        attempt,
        trace,
        summary,
        timeoutMs: loaded.modelConfig.reviewerTimeoutMs,
      });
      const result = await runSubagent({
        contract,
        traceWriter: traceJournal,
        now,
        invoker: (invocation) => runReviewerAgent({
          ...invocation,
          runner,
          agent: reviewerAgent,
        }),
        validateCompletedResult: (validatedContract, completedResult) =>
          validateReviewerAgentCompletedResult(
            validatedContract,
            completedResult,
            trace.length,
          ),
      });
      if (result.status === "completed") {
        return validateReviewerAgentCompletedResult(contract, result, trace.length);
      }
      return { ...result, status: result.status };
    },
  }),
});
```

Do not generate handoff in `runCodingMode` itself: its unit tests and provider-neutral orchestration should remain free of filesystem policy.

- [ ] **Step 5: Verify the integration and existing Coding tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-handoff-integration.test.ts tests/unit/coding-mode.test.ts tests/unit/coding-cli.test.ts
```

Expected: all tests PASS; no existing `CodingRunResult` assertion changes.

- [ ] **Step 6: Document the artifact boundary**

Add a `### Handoff artifact` subsection under `## Coding mode` in `README.md` explaining:

```markdown
每次 Coding mode 进入 completed、failed、blocked 或 cancelled 终态后，都会原子更新
workspace 根目录的 `handoff.md`。它只保留目标、当前状态、已完成步骤、开放问题、关键
证据、失败尝试和下一步行动，供新 Agent 或人类继续任务。完整事件历史仍位于本次 JSONL
trace；`handoff.md` 不复制长日志、原始 prompt 或 shell stdout/stderr。
```

- [ ] **Step 7: Run the full verification suite**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all unit tests PASS, TypeScript emits no errors, and `git diff --check` prints nothing.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/modes/coding/run-coding-mode-with-handoff.ts src/modes/coding/run-configured-coding-mode.ts tests/unit/coding-handoff-integration.test.ts README.md
git commit -m "feat: generate handoff after coding runs"
```

## Final Review Checklist

- [ ] Every requirement in `docs/superpowers/specs/2026-07-21-coding-handoff-artifact-design.md` maps to a task above.
- [ ] No production code was written before its focused test failed for the expected missing-feature reason.
- [ ] `handoff.md` generation occurs exactly once after every returned Coding terminal result.
- [ ] A pre-terminal exception does not overwrite the previous handoff.
- [ ] A handoff write failure rejects visibly and preserves the previous complete file.
- [ ] The renderer never consumes raw trace events.
- [ ] `npm test`, `npm run build`, and `git diff --check` pass immediately before completion is claimed.
