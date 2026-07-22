# Coding Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every Coding Agent model input by a deterministic character budget while preserving recent history, pinned workflow evidence, and actionable failure conclusions, with auditable before/after trace events.

**Architecture:** A provider-neutral `src/context/` module measures and groups SDK input, summarizes old function-tool results without a model call, and fails closed when protected content cannot fit. `runCodingAgent` installs this module through the Agents SDK `callModelInputFilter`, while the Coding workflow passes accepted evidence into the trusted coordinator envelope and the trace union records every actual compaction lifecycle.

**Tech Stack:** TypeScript 7, Node.js 22, ESM, `@openai/agents` 0.13.1, Zod 4, `node:test`, JSONL trace.

## Global Constraints

- Scope is Coding workflow only; do not change the ordinary `npm run loop` path, classifier, or reviewer model inputs.
- Use character accounting, not tokenizer-dependent estimates.
- Defaults are `maxInputChars: 60_000`, `keepRecentItems: 8`, and `maxToolSummaryChars: 1_200`.
- Summaries are deterministic and local; no extra model request is allowed.
- Tool call/result pairs are atomic and must never become orphaned.
- Protected content is never silently truncated; return `context_budget_exceeded` when it cannot fit.
- Every actual compaction writes started plus completed/failed trace events before the model call.
- Keep strict TypeScript, `.js` ESM imports, two-space indentation, double quotes, semicolons, and detailed Chinese comments around important logic and boundaries.
- Preserve the user's existing untracked `handoff.md`; do not stage or edit it.

---

## File Map

- Create `src/context/context-compaction-types.ts`: policy, result, summary-manifest, and error contracts.
- Create `src/context/context-item-groups.ts`: deterministic measurement and function call/result grouping.
- Create `src/context/summarize-tool-result.ts`: deterministic successful/failed tool-result summaries.
- Create `src/context/compact-coding-context.ts`: selection algorithm, budget enforcement, and trace lifecycle.
- Create `tests/unit/context-compaction.test.ts`: focused compactor unit tests.
- Modify `src/config/config-schema.ts`: parse and default compaction policy.
- Modify `config/loop.config.json`: declare checked-in compaction settings.
- Modify `src/trace/trace-event.ts`: add compaction lifecycle events.
- Modify `src/modes/coding/coding-state.ts`: pass pinned evidence and add the terminal reason.
- Modify `src/modes/coding/create-coding-workflow.ts`: forward accepted workflow evidence to the executor.
- Modify `src/modes/coding/run-configured-coding-mode.ts`: render pinned evidence and inject configured policy.
- Modify `src/modes/coding/run-coding-agent.ts`: install `callModelInputFilter` and map budget failures.
- Modify `tests/unit/config.test.ts`: configuration defaults, checked-in values, and invalid values.
- Modify `tests/unit/coding-agent.test.ts`: prompt trust boundary, SDK hook, trace failure, and budget terminal tests.
- Modify `tests/unit/coding-mode.test.ts`: workflow evidence forwarding and terminal propagation.
- Modify `README.md`: document runtime settings and compaction trace events.

---

### Task 1: Configuration and Trace Contracts

**Files:**
- Modify: `src/config/config-schema.ts`
- Modify: `config/loop.config.json`
- Modify: `src/trace/trace-event.ts`
- Modify: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `ContextCompactionConfig` through `LoopConfig["contextCompaction"]`.
- Produces: `context_compaction_started`, `context_compaction_completed`, and `context_compaction_failed` members of `TraceEvent`.
- Consumes: no interfaces from later tasks.

- [ ] **Step 1: Write failing configuration tests**

Add tests that assert the legacy default, checked-in values, and positive-integer validation:

```ts
test("defaults context compaction for legacy config files", () => {
  const parsed = parseLoopConfig(validConfig);

  assert.deepEqual(parsed.contextCompaction, {
    maxInputChars: 60_000,
    keepRecentItems: 8,
    maxToolSummaryChars: 1_200,
  });
});

test("rejects non-positive context compaction limits", () => {
  assert.throws(() => parseLoopConfig({
    ...validConfig,
    contextCompaction: {
      maxInputChars: 0,
      keepRecentItems: 8,
      maxToolSummaryChars: 1_200,
    },
  }));
});
```

Extend the checked-in-config test with an exact deep equality assertion for the three configured values.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/config.test.ts
```

Expected: FAIL because `contextCompaction` is absent from parsed and checked-in configuration.

- [ ] **Step 3: Add configuration and trace types**

Add this prefaulted schema to `src/config/config-schema.ts` and include it in `loopConfigSchema`:

```ts
const contextCompactionConfigSchema = z
  .object({
    maxInputChars: z.number().int().positive().default(60_000),
    keepRecentItems: z.number().int().positive().default(8),
    maxToolSummaryChars: z.number().int().positive().default(1_200),
  })
  .prefault({});

// inside loopConfigSchema
contextCompaction: contextCompactionConfigSchema,
```

Export the inferred type:

```ts
export type ContextCompactionConfig = z.infer<
  typeof contextCompactionConfigSchema
>;
```

Add the exact object to `config/loop.config.json` after `safetyLimits`.

Add the three interfaces from the approved design to `src/trace/trace-event.ts`. Define the shared failure reason as:

```ts
export type ContextCompactionFailureReason =
  | "invalid_tool_history"
  | "pinned_content_exceeds_budget";
```

Append all three event interfaces to the `TraceEvent` union.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/config.test.ts
npm run build
```

Expected: all config tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the contract slice**

```bash
git add src/config/config-schema.ts config/loop.config.json src/trace/trace-event.ts tests/unit/config.test.ts
git commit -m "feat: define context compaction contracts"
```

---

### Task 2: Deterministic Item Grouping and Tool Summaries

**Files:**
- Create: `src/context/context-compaction-types.ts`
- Create: `src/context/context-item-groups.ts`
- Create: `src/context/summarize-tool-result.ts`
- Create: `tests/unit/context-compaction.test.ts`

**Interfaces:**
- Consumes: `ContextCompactionConfig` from `src/config/config-schema.ts`.
- Produces: `measureModelInput(instructions, input): number`.
- Produces: `groupContextItems(input): ContextItemGroup[]`.
- Produces: `summarizeFunctionResult(group, maxChars): ToolResultSummary`.
- Produces: `ContextBudgetExceededError` for fail-closed outcomes.

- [ ] **Step 1: Write failing measurement and grouping tests**

Use real `AgentInputItem` shapes:

```ts
const call = {
  type: "function_call" as const,
  callId: "call-1",
  name: "workspace_shell",
  arguments: JSON.stringify({ executable: "npm", args: ["test"] }),
};
const result = {
  type: "function_call_result" as const,
  callId: "call-1",
  name: "workspace_shell",
  status: "completed" as const,
  output: JSON.stringify({ ok: true, data: { stdout: "x".repeat(2_000) } }),
};

test("groups a function call and result atomically", () => {
  const groups = groupContextItems([
    { role: "user", content: "diagnose" },
    call,
    result,
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1]?.items, [call, result]);
  assert.equal(groups[1]?.callId, "call-1");
});

test("rejects an orphan function result", () => {
  assert.throws(
    () => groupContextItems([result]),
    /orphan function result/i,
  );
});
```

Also assert that `measureModelInput` equals the length of one canonical JSON serialization containing `instructions` and `input`.

- [ ] **Step 2: Run the focused file and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/context-compaction.test.ts
```

Expected: FAIL because the context modules do not exist.

- [ ] **Step 3: Implement shared contracts, canonical measurement, and grouping**

Define focused contracts in `context-compaction-types.ts`:

```ts
import type { AgentInputItem } from "@openai/agents";
import type { ContextCompactionFailureReason } from "../trace/trace-event.js";

export interface ContextItemGroup {
  items: AgentInputItem[];
  callId?: string;
  functionName?: string;
  kind: "message" | "function_tool" | "opaque";
}

export interface ToolSummaryManifest {
  callId: string;
  status: "succeeded" | "failed";
  summaryChars: number;
}

export class ContextBudgetExceededError extends Error {
  public readonly name = "ContextBudgetExceededError";

  public constructor(
    public readonly reason: ContextCompactionFailureReason,
    message: string,
  ) {
    super(message);
  }
}
```

In `context-item-groups.ts`, use `JSON.stringify({ instructions, input }).length` for canonical measurement. Group a `function_call` with exactly one later `function_call_result` sharing `callId`; preserve original ordering; throw `ContextBudgetExceededError("invalid_tool_history", ...)` for duplicate calls, duplicate results, or orphans. Treat every other item as a one-item message/opaque group.

- [ ] **Step 4: Write failing deterministic-summary tests**

Add one success and one failure test. The failure fixture must use the real tool error envelope:

```ts
const failedResult = {
  type: "function_call_result" as const,
  callId: "call-failed",
  name: "workspace_shell",
  status: "completed" as const,
  output: JSON.stringify({
    ok: false,
    error: {
      type: "process_failed",
      message: "Focused test failed.",
      retryable: true,
      userActionRequired: false,
      suggestedNextStep: "Inspect the assertion diff.",
      evidence: { exitCode: 1, command: "npm test" },
    },
  }),
};
```

Assert identical inputs produce deeply equal summaries. Assert the success summary includes `compacted`, `callId`, `tool`, `originalChars`, and omission metadata. Assert the failure summary preserves every required error field and contains `conclusion: "attempt_failed"`. Assert every emitted summary is within `maxChars`; if mandatory failure fields alone exceed `maxChars`, assert `pinned_content_exceeds_budget` rather than truncation.

- [ ] **Step 5: Run the focused file and verify the new tests fail**

Run the same focused command. Expected: grouping tests pass; summary tests fail because `summarizeFunctionResult` is missing.

- [ ] **Step 6: Implement deterministic summaries**

Implement these semantics in `summarize-tool-result.ts`:

```ts
type ParsedToolEnvelope =
  | { ok: true; data?: unknown; evidence?: unknown }
  | { ok: false; error: ToolError };

// Successful output shape
{
  ok: true,
  compacted: true,
  callId,
  tool: functionName,
  originalChars,
  source,
  excerpt: { head, tail, omittedChars },
}

// Failed output shape
{
  ok: false,
  compacted: true,
  callId,
  tool: functionName,
  error: { type, message, retryable, userActionRequired,
           suggestedNextStep, evidence },
  conclusion: "attempt_failed",
}
```

Use stable property insertion order and a pure `clipHeadTail` helper. Parse JSON only when it matches the expected envelope; otherwise summarize the raw string as success data. Return a cloned `function_call_result` item with only `output` replaced.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/context-compaction.test.ts
npm run build
```

Expected: all new tests pass and build exits 0.

- [ ] **Step 8: Commit grouping and summarization**

```bash
git add src/context/context-compaction-types.ts src/context/context-item-groups.ts src/context/summarize-tool-result.ts tests/unit/context-compaction.test.ts
git commit -m "feat: summarize old coding tool context"
```

---

### Task 3: Budget Selection, Evidence Pinning, and Trace Lifecycle

**Files:**
- Create: `src/context/compact-coding-context.ts`
- Modify: `src/context/context-compaction-types.ts`
- Modify: `tests/unit/context-compaction.test.ts`

**Interfaces:**
- Consumes: grouping, measurement, summary functions, `TraceWriter`, and `ContextCompactionConfig`.
- Produces: `compactCodingContext(input): Promise<ModelInputData>` suitable for `callModelInputFilter`.
- Produces: `createPinnedEvidenceId(evidence): string` using a stable SHA-256 digest.

- [ ] **Step 1: Write failing no-op, recent-window, and hard-bound tests**

Create a memory trace writer in the test file. Add tests proving:

```ts
test("returns the original model input without trace when under budget", async () => {
  const modelData = { instructions: "rules", input: [{ role: "user" as const, content: "task" }] };
  const traceWriter = new MemoryTraceWriter();

  const compacted = await compactCodingContext({
    modelData,
    config: { maxInputChars: 1_000, keepRecentItems: 2, maxToolSummaryChars: 200 },
    pinnedEvidence: [],
    traceWriter,
    now: () => "2026-07-22T00:00:00.000Z",
  });

  assert.deepEqual(compacted, modelData);
  assert.deepEqual(traceWriter.events, []);
});
```

For the over-budget fixture, build one initial user item plus at least four tool groups. Assert the last two groups are deeply equal to their originals, earlier successful results are summarized, no call IDs are lost, and `measureModelInput(...) <= maxInputChars`.

- [ ] **Step 2: Run the focused file and verify RED**

Expected: FAIL because `compactCodingContext` does not exist.

- [ ] **Step 3: Implement the selection algorithm**

Implement the approved order:

1. Return the exact `modelData` reference when under budget.
2. Group and validate input.
3. Write `context_compaction_started`.
4. Protect instructions, the first input group, all failure summaries, and the final `keepRecentItems` groups.
5. Summarize older successful function results.
6. If still over budget, remove oldest unprotected message/opaque groups.
7. Re-group the output and remeasure it.
8. Write completed and return, or write failed and throw `ContextBudgetExceededError`.

Create evidence IDs with:

```ts
createHash("sha256")
  .update(JSON.stringify({
    kind: evidence.kind,
    source: evidence.source,
    summary: evidence.summary,
  }))
  .digest("hex")
  .slice(0, 16);
```

Trace only IDs and sanitized summary manifests, never the original large model input.

- [ ] **Step 4: Add failing evidence, failure, and trace-order tests**

Add tests that assert:

- supplied pinned evidence IDs appear unchanged in `context_compaction_completed`;
- an old failed result retains the exact required fields and conclusion after compaction;
- events are exactly `["context_compaction_started", "context_compaction_completed"]`;
- protected prefix plus recent groups exceeding the budget produces started then failed with `pinned_content_exceeds_budget`;
- a writer that rejects the completed event causes the promise to reject and never returns model data.

- [ ] **Step 5: Run the focused file and verify RED for the new cases**

Expected: the basic compaction case passes; at least the protected-budget or trace-failure case fails until fail-closed handling is complete.

- [ ] **Step 6: Complete fail-closed handling**

Centralize failure recording in an internal helper:

```ts
async function failCompaction(
  reason: ContextCompactionFailureReason,
  message: string,
): Promise<never> {
  await traceWriter.write({
    event: "context_compaction_failed",
    timestamp: now(),
    budgetChars: config.maxInputChars,
    beforeChars,
    reason,
  });
  throw new ContextBudgetExceededError(reason, message);
}
```

Do not catch trace writer errors in this helper. A persistence failure must remain distinguishable from a context-budget failure.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/context-compaction.test.ts
npm run build
```

Expected: compaction tests pass, no orphan tool items exist, and build exits 0.

- [ ] **Step 8: Commit the compactor**

```bash
git add src/context/compact-coding-context.ts src/context/context-compaction-types.ts tests/unit/context-compaction.test.ts
git commit -m "feat: enforce coding context budget"
```

---

### Task 4: Connect Workflow Evidence and the SDK Input Filter

**Files:**
- Modify: `src/modes/coding/coding-state.ts`
- Modify: `src/modes/coding/create-coding-workflow.ts`
- Modify: `src/modes/coding/run-configured-coding-mode.ts`
- Modify: `src/modes/coding/run-coding-agent.ts`
- Modify: `tests/unit/coding-mode.test.ts`
- Modify: `tests/unit/coding-agent.test.ts`

**Interfaces:**
- Consumes: `compactCodingContext`, `ContextCompactionConfig`, and `WorkflowEvidence[]`.
- Changes: `CodingExecutor` input gains `pinnedEvidence: WorkflowEvidence[]`.
- Changes: `runCodingAgent` input gains `contextCompaction` and `pinnedEvidence`.
- Changes: `CodingStopReason` gains `context_budget_exceeded`.

- [ ] **Step 1: Write failing workflow evidence-forwarding tests**

In `tests/unit/coding-mode.test.ts`, capture the executor argument during the first attempt and a reviewer-driven retry. Assert:

```ts
assert.deepEqual(firstCall.pinnedEvidence, [
  { kind: "classification_objective", source: taskType, summary: "Normalized objective" },
  { kind: "classification_reason", source: taskType, summary: "Matched test workflow" },
]);
assert.ok(secondCall.pinnedEvidence.some(
  (item) => item.kind === "review_decision",
));
```

Add `context_budget_exceeded` to the terminal-forwarding table and assert it yields failed status with no final output.

- [ ] **Step 2: Run the focused workflow tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts
```

Expected: FAIL because `CodingExecutor` does not receive `pinnedEvidence` and the stop reason is unknown.

- [ ] **Step 3: Thread pinned evidence through the workflow**

Add the field to `CodingExecutor` and pass a defensive copy from `createCodingWorkflow`:

```ts
const executorResult = await input.executor({
  request: state.request,
  classification: state.classification,
  instructions: prompt.instructions,
  revisionInstructions: state.revisionInstructions,
  pinnedEvidence: [...state.evidence],
});
```

Add `context_budget_exceeded` to `CodingStopReason` and `CODING_STOP_REASONS`.

- [ ] **Step 4: Write failing prompt and SDK-hook tests**

Extend `createCodingExecutorPrompt` tests to supply `pinnedEvidence` and assert it appears only under:

```ts
coordinatorData: {
  workflowInstructions,
  contextPackage: { pinnedEvidence },
}
```

Add a `runCodingAgent` test whose fake runner captures `options.callModelInputFilter`, invokes it with an over-budget model input, and asserts:

- the callback exists;
- the returned input is within budget;
- the runner receives `maxTurns` unchanged;
- compaction trace precedes the fake model result.

Add a second fake-runner test that feeds protected content larger than the budget and asserts `runCodingAgent` returns:

```ts
{
  type: "stopped",
  status: "failed",
  reason: "context_budget_exceeded",
}
```

Add a third test where the trace writer rejects during the filter and assert the original trace error rejects `runCodingAgent` rather than becoming a stopped result.

- [ ] **Step 5: Run the focused agent tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts
```

Expected: FAIL because prompt and run options do not yet include compaction context.

- [ ] **Step 6: Install the filter at the Coding Agent boundary**

Update `createCodingExecutorPrompt` to include a copied evidence array in trusted coordinator data. In the configured composition, pass:

```ts
return runCodingAgent({
  runner,
  agent: codingAgent,
  prompt,
  maxTurns,
  contextCompaction: loaded.config.contextCompaction,
  pinnedEvidence,
  traceWriter: traceJournal,
  now,
});
```

Update the SDK call:

```ts
result = await input.runner.run(input.agent, input.prompt, {
  maxTurns: input.maxTurns,
  callModelInputFilter: ({ modelData }) => compactCodingContext({
    modelData,
    config: input.contextCompaction,
    pinnedEvidence: input.pinnedEvidence,
    traceWriter: input.traceWriter,
    now: input.now,
  }),
});
```

Catch only `ContextBudgetExceededError` and return the new stopped result. Preserve the existing exact unwrapping of `ToolCallError` containing `TraceInfrastructureError`; do not broadly catch trace failures.

For existing direct unit-test callers, update every `runCodingAgent` invocation with a small shared test policy and `pinnedEvidence: []`; do not add permissive production defaults at the adapter boundary.

- [ ] **Step 7: Run focused tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts tests/unit/coding-mode.test.ts
npm run build
```

Expected: both test files pass and build exits 0.

- [ ] **Step 8: Commit the Coding integration**

```bash
git add src/modes/coding/coding-state.ts src/modes/coding/create-coding-workflow.ts src/modes/coding/run-configured-coding-mode.ts src/modes/coding/run-coding-agent.ts tests/unit/coding-agent.test.ts tests/unit/coding-mode.test.ts
git commit -m "feat: compact coding agent model input"
```

---

### Task 5: Documentation and Full Regression Verification

**Files:**
- Modify: `README.md`
- Test: `tests/unit/context-compaction.test.ts`
- Test: `tests/unit/coding-agent.test.ts`
- Test: `tests/unit/coding-mode.test.ts`

**Interfaces:**
- Consumes: all completed runtime behavior.
- Produces: user-facing configuration and trace documentation.

- [ ] **Step 1: Add the long-history regression test before documentation**

Build a deterministic fixture containing at least 20 tool groups, including:

- one old successful output larger than `maxToolSummaryChars`;
- one old failed attempt with all required error fields;
- one pinned workflow evidence item;
- eight recent groups with unique exact payloads.

Invoke the actual callback captured from `runCodingAgent`. Assert the model-facing input stays under `maxInputChars`, all eight recent groups are unchanged, the pinned evidence remains in the trusted first prompt, the old failure conclusion remains present, and trace reports at least one summarized tool result.

- [ ] **Step 2: Run the regression test and confirm it passes against the integrated behavior**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/context-compaction.test.ts tests/unit/coding-agent.test.ts
```

Expected: PASS. This is an integration regression added after the lower-level red/green cycles; if it fails, fix production code and rerun both files before continuing.

- [ ] **Step 3: Document configuration, behavior, and trace events**

Add a concise README section explaining:

```text
Coding mode applies deterministic context compaction before each internal model turn.
It preserves the latest logical tool/message groups, accepted workflow evidence, and
actionable failure conclusions. Older successful tool output becomes a bounded local
summary. If protected content cannot fit, the run stops with context_budget_exceeded.
```

Document the three config keys and the started/completed/failed event names. State that JSONL tool events remain the full audit source and compaction trace does not duplicate raw large output.

- [ ] **Step 4: Run complete verification from a clean command invocation**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all unit tests pass with zero failures, build exits 0, and `git diff --check` prints no errors.

- [ ] **Step 5: Review the two user checkpoints against fresh evidence**

Confirm from test names and output:

```text
[x] Long Coding tasks have a hard model-input character bound.
[x] Recent logical groups retain original content.
[x] Old tool results become deterministic summaries.
[x] Pinned evidence remains in the trusted context package and trace IDs.
[x] Failed attempts retain reason, retry/user-action fields, next step, and conclusion.
[x] Actual compaction has before and after trace events.
```

If any line cannot be tied to a passing test, add the missing failing test, implement the minimum fix, and rerun the full verification commands.

- [ ] **Step 6: Commit documentation and final regression coverage**

```bash
git add README.md tests/unit/context-compaction.test.ts tests/unit/coding-agent.test.ts
git commit -m "docs: explain coding context compaction"
```
