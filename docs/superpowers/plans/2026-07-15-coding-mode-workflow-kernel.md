# Coding Mode Workflow Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run loop -- coding "<natural-language request>"` with four read-only coding workflows, structured JSONL trace events, and explicit task-level stop reasons.

**Architecture:** Add a small mode-neutral Workflow Kernel whose steps return typed transitions. The coding mode classifies natural-language input, selects a two-step workflow, and delegates evidence gathering to a read-only coding Agent; existing model, tool, permission, and trace infrastructure remain adapters at the composition root.

**Tech Stack:** TypeScript 7, Node.js 22+, ESM, `@openai/agents`, Zod 4, `node:test`, JSONL.

## Global Constraints

- Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons.
- Add detailed Chinese comments around important logic, including data flow, failure handling, and boundaries.
- Preserve `npm run loop -- "普通任务"` behavior.
- Coding mode must not intentionally edit source files or expose a file-write tool. Permission-checked test and build commands may create temporary files or generated output such as `dist/`.
- A request for implementation maps to a read-only implementation plan and must state that no files were modified.
- Every coding run writes a per-run JSONL trace and ends with an explicit stop reason whenever its trace writer remains available.
- Trace write failures propagate; a run with an untrustworthy trace must never report success.
- Unit tests remain offline and deterministic through injected classifier, executor, clock, and trace dependencies.
- Do not implement context compaction, subagents, file editing, automatic repair, diff review, or commits inside coding mode in this milestone.

---

## File Map

Create:

- `src/runtime/workflow-types.ts`: mode-neutral workflow contracts.
- `src/runtime/run-workflow.ts`: step execution, transition validation, step limits, and workflow trace events.
- `src/modes/coding/coding-task.ts`: coding task classification schema and stop-reason types.
- `src/modes/coding/coding-state.ts`: coding workflow state and final result.
- `src/modes/coding/coding-classifier.ts`: structured classifier Agent adapter.
- `src/modes/coding/coding-output.ts`: structured coding Agent output schema.
- `src/modes/coding/create-coding-agent.ts`: task Agent instructions.
- `src/modes/coding/run-coding-agent.ts`: Agent execution adapter and approval-required result.
- `src/modes/coding/create-coding-workflow.ts`: task-specific prompts and workflow definition.
- `src/modes/coding/run-coding-mode.ts`: classification, workflow orchestration, terminal trace, and final result.
- `src/modes/coding/run-configured-coding-mode.ts`: config/model/tools/trace composition.
- `src/agents/tools/read-only-file-tool.ts`: physical read-only file-tool boundary.
- `src/agents/tools/create-coding-tools.ts`: read/search/shell tool set without file writes.
- `tests/unit/workflow-runner.test.ts`: Workflow Kernel behavior.
- `tests/unit/coding-task.test.ts`: classification and stop-reason schema behavior.
- `tests/unit/read-only-file-tool.test.ts`: write requests cannot enter coding mode.
- `tests/unit/coding-mode.test.ts`: all four workflows, terminal reasons, traces, and failure paths.
- `tests/unit/cli-mode.test.ts`: CLI parsing and backward compatibility.

Modify:

- `src/trace/trace-event.ts`: add workflow and coding event variants.
- `src/cli.ts`: parse mode and dispatch to configured coding mode.
- `README.md`: document coding mode, supported tasks, read-only boundary, trace, and stop reasons.

Existing tools stay in place. Do not move `src/agents/tools/` or rewrite the existing seven-stage loop.

---

### Task 1: Mode-Neutral Workflow Kernel

**Files:**
- Create: `src/runtime/workflow-types.ts`
- Create: `src/runtime/run-workflow.ts`
- Modify: `src/trace/trace-event.ts`
- Test: `tests/unit/workflow-runner.test.ts`

**Interfaces:**
- Consumes: existing `TraceWriter.write(event: TraceEvent): Promise<void>`.
- Produces: `WorkflowStep<State>`, `WorkflowDefinition<State>`, `WorkflowRunResult<State>`, and `runWorkflow<State>(options)`.

- [ ] **Step 1: Write failing kernel tests**

Create `tests/unit/workflow-runner.test.ts` with a memory trace writer and these cases:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorkflow } from "../../src/runtime/run-workflow.js";
import type { WorkflowDefinition } from "../../src/runtime/workflow-types.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

interface State {
  visits: string[];
}

test("runs named steps and records the terminal transition", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "inspect",
    steps: new Map([
      ["inspect", {
        name: "inspect",
        run: async (state) => ({
          state: { visits: [...state.visits, "inspect"] },
          evidence: [{ kind: "file", source: "src/a.ts", summary: "read" }],
          transition: { type: "next", step: "summarize", reason: "context_ready" },
        }),
      }],
      ["summarize", {
        name: "summarize",
        run: async (state) => ({
          state: { visits: [...state.visits, "summarize"] },
          evidence: [],
          transition: { type: "stop", status: "completed", reason: "done" },
        }),
      }],
    ]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 3,
    traceWriter,
    now: () => "2026-07-15T00:00:00.000Z",
  });

  assert.deepEqual(result.state.visits, ["inspect", "summarize"]);
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "done");
  assert.equal(result.completedSteps, 2);
  assert.deepEqual(traceWriter.events.map((event) => event.event), [
    "workflow_step_started",
    "workflow_step_completed",
    "workflow_transition_decided",
    "workflow_step_started",
    "workflow_step_completed",
    "workflow_transition_decided",
  ]);
});

test("fails an unknown transition target", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "inspect",
    steps: new Map([["inspect", {
      name: "inspect",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "next", step: "missing", reason: "bad_route" },
      }),
    }]]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 3,
    traceWriter,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "workflow_step_failed");
  assert.equal(traceWriter.events.at(-1)?.event, "workflow_step_failed");
});

test("stops at the workflow step limit", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "again",
    steps: new Map([["again", {
      name: "again",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "next", step: "again", reason: "repeat" },
      }),
    }]]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 1,
    traceWriter,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "max_workflow_steps_exceeded");
});

test("propagates trace write failures", async () => {
  const definition: WorkflowDefinition<State> = {
    initialStep: "done",
    steps: new Map([["done", {
      name: "done",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "stop", status: "completed", reason: "done" },
      }),
    }]]),
  };

  await assert.rejects(
    runWorkflow({
      definition,
      initialState: { visits: [] },
      maxSteps: 1,
      traceWriter: { write: async () => { throw new Error("trace unavailable"); } },
    }),
    /trace unavailable/,
  );
});
```

- [ ] **Step 2: Run the kernel test and verify it fails**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts
```

Expected: FAIL because `src/runtime/run-workflow.ts` and `workflow-types.ts` do not exist.

- [ ] **Step 3: Add workflow contracts**

Create `src/runtime/workflow-types.ts`:

```ts
export type WorkflowStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface WorkflowEvidence {
  kind: string;
  source: string;
  summary: string;
}

export type WorkflowTransition =
  | { type: "next"; step: string; reason: string }
  | { type: "stop"; status: WorkflowStatus; reason: string };

export interface WorkflowStepResult<State> {
  state: State;
  evidence: WorkflowEvidence[];
  transition: WorkflowTransition;
}

export interface WorkflowStep<State> {
  name: string;
  run(state: State): Promise<WorkflowStepResult<State>>;
}

export interface WorkflowDefinition<State> {
  initialStep: string;
  steps: ReadonlyMap<string, WorkflowStep<State>>;
}

export interface WorkflowRunResult<State> {
  state: State;
  status: WorkflowStatus;
  stopReason: string;
  completedSteps: number;
}
```

- [ ] **Step 4: Extend the structured trace union**

In `src/trace/trace-event.ts`, add workflow event interfaces with `timestamp`, `step`, and `stepIndex`. The completed event carries `evidence: WorkflowEvidence[]`; the failed event carries the existing sanitized `StepError`; the transition event carries `transition: WorkflowTransition`. Add all four interfaces to `TraceEvent`:

```ts
export interface WorkflowStepStartedEvent {
  event: "workflow_step_started";
  timestamp: string;
  step: string;
  stepIndex: number;
}

export interface WorkflowStepCompletedEvent {
  event: "workflow_step_completed";
  timestamp: string;
  step: string;
  stepIndex: number;
  evidence: WorkflowEvidence[];
}

export interface WorkflowStepFailedEvent {
  event: "workflow_step_failed";
  timestamp: string;
  step: string;
  stepIndex: number;
  error: StepError;
}

export interface WorkflowTransitionDecidedEvent {
  event: "workflow_transition_decided";
  timestamp: string;
  step: string;
  stepIndex: number;
  transition: WorkflowTransition;
}
```

Import `WorkflowEvidence` and `WorkflowTransition` from `../runtime/workflow-types.js`.

- [ ] **Step 5: Implement the runner**

Create `src/runtime/run-workflow.ts`. Use a loop that writes started/completed/transition events, validates the destination before the next iteration, converts step exceptions and invalid destinations to `workflow_step_failed`, and returns `max_workflow_steps_exceeded` after the configured number of steps. Use this sanitizer:

```ts
function sanitizeError(error: unknown): StepError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}
```

The exported signature must be:

```ts
export async function runWorkflow<State>(options: {
  definition: WorkflowDefinition<State>;
  initialState: State;
  maxSteps: number;
  traceWriter: TraceWriter;
  now?: () => string;
}): Promise<WorkflowRunResult<State>>;
```

Validate `maxSteps` as a positive integer before writing trace data. If the initial step is absent, return `workflow_step_failed` after writing a `workflow_step_failed` event with `stepIndex: 0`. Never catch an error thrown by `traceWriter.write()`.

- [ ] **Step 6: Run tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts
npm run build
```

Expected: all four kernel tests PASS and TypeScript compilation succeeds.

- [ ] **Step 7: Commit the kernel**

```bash
git add src/runtime/workflow-types.ts src/runtime/run-workflow.ts src/trace/trace-event.ts tests/unit/workflow-runner.test.ts
git commit -m "feat: add mode-neutral workflow kernel"
```

---

### Task 2: Coding Task and Stop Contracts

**Files:**
- Create: `src/modes/coding/coding-task.ts`
- Create: `src/modes/coding/coding-state.ts`
- Test: `tests/unit/coding-task.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvidence` and `WorkflowStatus` from Task 1.
- Produces: `codingTaskClassificationSchema`, `CodingTaskClassification`, `CodingClassifier`, `CodingStopReason`, `CodingExecutorResult`, `CodingRunResult`.

- [ ] **Step 1: Write schema tests**

Create `tests/unit/coding-task.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODING_TASK_TYPES,
  codingTaskClassificationSchema,
} from "../../src/modes/coding/coding-task.js";

test("accepts every supported coding task classification", () => {
  for (const taskType of CODING_TASK_TYPES) {
    const parsed = codingTaskClassificationSchema.parse({
      taskType,
      objective: "Inspect the repository",
      reason: "The request matches this workflow",
    });
    assert.equal(parsed.taskType, taskType);
  }
});

test("rejects an unknown task classification", () => {
  assert.equal(codingTaskClassificationSchema.safeParse({
    taskType: "implement_change",
    objective: "Edit files",
    reason: "Unsupported in this milestone",
  }).success, false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run `./node_modules/.bin/tsx --test tests/unit/coding-task.test.ts`.

Expected: FAIL because the coding contracts do not exist.

- [ ] **Step 3: Implement coding task contracts**

Create `src/modes/coding/coding-task.ts`:

```ts
import { z } from "zod";

export const CODING_TASK_TYPES = [
  "explain_module",
  "find_related_files",
  "diagnose_test_failure",
  "propose_implementation_plan",
] as const;

export const codingTaskClassificationSchema = z.object({
  taskType: z.enum(CODING_TASK_TYPES),
  objective: z.string().min(1),
  reason: z.string().min(1),
});

export type CodingTaskClassification = z.infer<
  typeof codingTaskClassificationSchema
>;

export type CodingTaskType = CodingTaskClassification["taskType"];

export type CodingClassifier = (
  request: string,
) => Promise<CodingTaskClassification>;
```

Create `src/modes/coding/coding-state.ts` with exact terminal contracts:

```ts
import type {
  WorkflowEvidence,
  WorkflowStatus,
} from "../../runtime/workflow-types.js";
import type { CodingTaskClassification } from "./coding-task.js";

export type CodingStopReason =
  | "explanation_completed"
  | "related_files_identified"
  | "diagnosis_completed"
  | "implementation_plan_completed"
  | "classification_failed"
  | "workflow_step_failed"
  | "max_workflow_steps_exceeded"
  | "tool_error"
  | "user_action_required"
  | "approval_required"
  | "approval_rejected"
  | "runtime_error";

export interface CodingWorkflowState {
  request: string;
  classification: CodingTaskClassification;
  output: string | null;
  evidence: WorkflowEvidence[];
}

export type CodingExecutorResult =
  | { type: "completed"; output: string; evidence: WorkflowEvidence[] }
  | {
      type: "stopped";
      status: Exclude<WorkflowStatus, "completed">;
      reason: Exclude<CodingStopReason,
        | "explanation_completed"
        | "related_files_identified"
        | "diagnosis_completed"
        | "implementation_plan_completed"
      >;
    };

export type CodingExecutor = (input: {
  request: string;
  classification: CodingTaskClassification;
  instructions: string;
}) => Promise<CodingExecutorResult>;

export interface CodingRunResult {
  status: WorkflowStatus;
  taskType: CodingTaskClassification["taskType"] | null;
  stopReason: CodingStopReason;
  completedSteps: number;
  finalOutput: string | null;
  tracePath: string;
}
```

- [ ] **Step 4: Run tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-task.test.ts
npm run build
```

Expected: both schema tests PASS and compilation succeeds.

- [ ] **Step 5: Commit the contracts**

```bash
git add src/modes/coding/coding-task.ts src/modes/coding/coding-state.ts tests/unit/coding-task.test.ts
git commit -m "feat: define coding mode contracts"
```

---

### Task 3: Read-Only Coding Tool Boundary

**Files:**
- Create: `src/agents/tools/read-only-file-tool.ts`
- Create: `src/agents/tools/create-coding-tools.ts`
- Test: `tests/unit/read-only-file-tool.test.ts`

**Interfaces:**
- Consumes: `executeFileTool`, `traceToolExecution`, search/shell tool factories, `ToolRuntimeConfig`, `TraceWriter`, and `ToolOutcomeRecorder`.
- Produces: `readOnlyFileInputSchema`, `createReadOnlyFileTool(...)`, `createCodingTools(...)`.

- [ ] **Step 1: Write the read-only boundary test**

Create `tests/unit/read-only-file-tool.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { readOnlyFileInputSchema } from "../../src/agents/tools/read-only-file-tool.js";

test("accepts file reads", () => {
  assert.deepEqual(
    readOnlyFileInputSchema.parse({ path: "src/cli.ts" }),
    { path: "src/cli.ts" },
  );
});

test("rejects the existing file tool write shape", () => {
  assert.equal(readOnlyFileInputSchema.safeParse({
    action: "write",
    path: "src/new.ts",
    content: "unsafe",
    overwrite: true,
  }).success, false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run `./node_modules/.bin/tsx --test tests/unit/read-only-file-tool.test.ts`.

Expected: FAIL because the read-only tool does not exist.

- [ ] **Step 3: Implement the read-only file tool**

Create `src/agents/tools/read-only-file-tool.ts`. Export this strict schema:

```ts
export const readOnlyFileInputSchema = z.object({
  path: z.string().min(1),
}).strict();
```

Create an Agents SDK tool named `workspace_file_read` whose description only promises UTF-8 reads. Its executor must call:

```ts
traceToolExecution({
  tool: "file",
  operation: "read",
  inputSummary: { path: input.path },
  traceWriter,
  outcomeRecorder,
  execute: () => executeFileTool({ action: "read", path: input.path }, runtime),
});
```

Its `errorFunction` must use the same traced `invalid_input` contract style as the existing file tool, with evidence `{ tool: "file", operation: "adapter" }`. No write action, content field, or overwrite field may exist in this tool schema.

- [ ] **Step 4: Assemble coding tools without the writable file tool**

Create `src/agents/tools/create-coding-tools.ts`:

```ts
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { createReadOnlyFileTool } from "./read-only-file-tool.js";
import { createSearchTool } from "./search-tool.js";
import { createShellTool } from "./shell-tool.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";

export function createCodingTools(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return [
    createReadOnlyFileTool(runtime, traceWriter, outcomeRecorder),
    createSearchTool(runtime, traceWriter, outcomeRecorder),
    createShellTool(runtime, traceWriter, outcomeRecorder),
  ];
}
```

- [ ] **Step 5: Run tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/read-only-file-tool.test.ts
npm run build
```

Expected: both read-only schema tests PASS and compilation succeeds.

- [ ] **Step 6: Commit the tool boundary**

```bash
git add src/agents/tools/read-only-file-tool.ts src/agents/tools/create-coding-tools.ts tests/unit/read-only-file-tool.test.ts
git commit -m "feat: add read-only coding tools"
```

---

### Task 4: Classifier and Coding Agent Adapters

**Files:**
- Create: `src/modes/coding/coding-classifier.ts`
- Create: `src/modes/coding/coding-output.ts`
- Create: `src/modes/coding/create-coding-agent.ts`
- Create: `src/modes/coding/run-coding-agent.ts`
- Test: `tests/unit/coding-agent.test.ts`

**Interfaces:**
- Consumes: `Runner`, Agents SDK `Agent`, Task 2 schemas, and Task 3 read-only tools.
- Produces: `createCodingClassifierAgent(modelConfig)`, `classifyCodingRequest(...)`, `createCodingAgent(...)`, `runCodingAgent(...)`.

- [ ] **Step 1: Write adapter tests with recording fakes**

Create `tests/unit/coding-agent.test.ts`. Use a fake object exposing `run()` and cast it to `Runner` at the call boundary. Cover:

```ts
test("returns structured classifier output", async () => {
  const expected = {
    taskType: "explain_module" as const,
    objective: "Explain src/loop",
    reason: "The request asks how a module works",
  };
  const runner = {
    run: async () => ({ finalOutput: expected, interruptions: [] }),
  } as unknown as Runner;

  assert.deepEqual(
    await classifyCodingRequest(runner, {} as CodingClassifierAgent, "解释 loop"),
    expected,
  );
});

test("rejects a classifier response without final output", async () => {
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [] }),
  } as unknown as Runner;

  await assert.rejects(
    classifyCodingRequest(runner, {} as CodingClassifierAgent, "解释 loop"),
    /Classifier returned no structured output/,
  );
});

test("turns a coding tool interruption into approval_required", async () => {
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [{}] }),
  } as unknown as Runner;

  const result = await runCodingAgent({
    runner,
    agent: {} as CodingAgent,
    prompt: "diagnose",
    maxTurns: 5,
  });

  assert.deepEqual(result, {
    type: "stopped",
    status: "blocked",
    reason: "approval_required",
  });
});

test("keeps a nonzero test exit as completed diagnostic evidence", async () => {
  const finalOutput = {
    output: "The assertion failed because the expected status differs.",
    evidence: [{
      kind: "test-output",
      source: "npm test",
      summary: "exitCode=1; assertion expected completed but received failed",
    }],
  };
  const runner = {
    run: async () => ({ finalOutput, interruptions: [] }),
  } as unknown as Runner;

  assert.deepEqual(await runCodingAgent({
    runner,
    agent: {} as CodingAgent,
    prompt: "diagnose the failing test",
    maxTurns: 5,
  }), {
    type: "completed",
    ...finalOutput,
  });
});
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Run `./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts`.

Expected: FAIL because the adapters and Agent types do not exist.

- [ ] **Step 3: Implement the classifier Agent**

In `src/modes/coding/coding-classifier.ts`, construct an Agent with `outputType: codingTaskClassificationSchema`, no tools, and instructions that define the four task types. The instructions must explicitly map requests that ask to create, implement, refactor, or fix code to `propose_implementation_plan` for this milestone. Export:

```ts
export type CodingClassifierAgent = Agent<
  unknown,
  typeof codingTaskClassificationSchema
>;

export function createCodingClassifierAgent(
  modelConfig: ModelConfig,
): CodingClassifierAgent;

export async function classifyCodingRequest(
  runner: Runner,
  agent: CodingClassifierAgent,
  request: string,
  maxTurns = 3,
): Promise<CodingTaskClassification>;
```

`classifyCodingRequest` trims the request, rejects empty input, calls `runner.run(agent, request, { maxTurns })`, and throws `Classifier returned no structured output` when `finalOutput` is absent.

- [ ] **Step 4: Implement the coding output and Agent**

Create `src/modes/coding/coding-output.ts`:

```ts
import { z } from "zod";

export const codingOutputSchema = z.object({
  output: z.string().min(1),
  evidence: z.array(z.object({
    kind: z.string().min(1),
    source: z.string().min(1),
    summary: z.string().min(1),
  })),
});
```

Create `src/modes/coding/create-coding-agent.ts`. The Agent instructions must require local evidence, forbid claiming file changes, forbid attempting file writes through shell, treat nonzero test output as diagnostic evidence, and return concise Chinese when the request is Chinese. Export `CodingAgent` and `createCodingAgent(modelConfig, tools)`.

- [ ] **Step 5: Implement the coding Agent runner**

Create `src/modes/coding/run-coding-agent.ts` with this signature:

```ts
export async function runCodingAgent(input: {
  runner: Runner;
  agent: CodingAgent;
  prompt: string;
  maxTurns: number;
}): Promise<CodingExecutorResult>;
```

Call `runner.run(input.agent, input.prompt, { maxTurns: input.maxTurns })`. If `interruptions.length > 0`, return the exact `approval_required` blocked result from the test; this milestone does not resume approval-interrupted coding runs. If there is no `finalOutput`, return `{ type: "stopped", status: "failed", reason: "runtime_error" }`. Otherwise return `{ type: "completed", output, evidence }`.

- [ ] **Step 6: Run tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts
npm run build
```

Expected: adapter tests PASS and compilation succeeds.

- [ ] **Step 7: Commit the Agent adapters**

```bash
git add src/modes/coding/coding-classifier.ts src/modes/coding/coding-output.ts src/modes/coding/create-coding-agent.ts src/modes/coding/run-coding-agent.ts tests/unit/coding-agent.test.ts
git commit -m "feat: add coding mode agents"
```

---

### Task 5: Coding Workflows, Trace, and Stop Reasons

**Files:**
- Create: `src/modes/coding/create-coding-workflow.ts`
- Create: `src/modes/coding/run-coding-mode.ts`
- Modify: `src/trace/trace-event.ts`
- Test: `tests/unit/coding-mode.test.ts`

**Interfaces:**
- Consumes: Task 1 `runWorkflow`, Task 2 contracts, and injected `CodingClassifier`/`CodingExecutor`.
- Produces: `createCodingWorkflow(...)` and `runCodingMode(...)`.

- [ ] **Step 1: Write coding-mode tests**

Create `tests/unit/coding-mode.test.ts` with a memory trace writer. Iterate over this table and assert final task type, stop reason, output, and terminal event:

```ts
const cases = [
  ["explain_module", "explanation_completed"],
  ["find_related_files", "related_files_identified"],
  ["diagnose_test_failure", "diagnosis_completed"],
  ["propose_implementation_plan", "implementation_plan_completed"],
] as const;
```

For every case, inject:

```ts
classifier: async () => ({
  taskType,
  objective: "Normalized objective",
  reason: "Matched test workflow",
}),
executor: async () => ({
  type: "completed",
  output: taskType === "propose_implementation_plan"
    ? "Implementation plan. No files were modified."
    : "Evidence-backed result",
  evidence: [{ kind: "file", source: "src/cli.ts", summary: "inspected" }],
}),
```

Assert the event order begins with `coding_run_started`, contains `coding_task_classified`, contains workflow events, and ends with `coding_run_stopped` carrying the expected reason.

Add three more tests:

1. A classifier that throws produces `status: "failed"`, `stopReason: "classification_failed"`, `taskType: null`, and a terminal trace.
2. An executor returning `{ type: "stopped", status: "blocked", reason: "approval_required" }` produces the same status/reason in the terminal trace.
3. A trace writer that throws rejects `runCodingMode`; it must not return a successful result.

- [ ] **Step 2: Run the tests and verify they fail**

Run `./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts`.

Expected: FAIL because coding workflow orchestration does not exist.

- [ ] **Step 3: Add coding-level trace events**

Extend `src/trace/trace-event.ts` with:

```ts
export interface CodingRunStartedEvent {
  event: "coding_run_started";
  timestamp: string;
  request: string;
  mode: "coding";
  activeModel: string;
}

export interface CodingTaskClassifiedEvent {
  event: "coding_task_classified";
  timestamp: string;
  classification: CodingTaskClassification;
}

export interface CodingRunStoppedEvent {
  event: "coding_run_stopped";
  timestamp: string;
  status: WorkflowStatus;
  taskType: CodingTaskType | null;
  stopReason: CodingStopReason;
  completedSteps: number;
}
```

Add them to `TraceEvent`. Import the coding and workflow types with ESM `.js` suffixes.

- [ ] **Step 4: Implement task-specific workflow prompts**

Create `src/modes/coding/create-coding-workflow.ts`. Use a complete `Record<CodingTaskType, { stopReason; instructions }>`:

- `explain_module`: require responsibilities, entry points, dependencies, data flow, and failure boundaries.
- `find_related_files`: require grouped paths, relationship reasons, and an explicit empty result when no files match.
- `diagnose_test_failure`: require the narrowest configured test command, exit evidence, failing test and implementation inspection, root-cause hypothesis, confidence, and next action; forbid edits.
- `propose_implementation_plan`: require repository conventions, likely files, ordered steps, tests, risks, and the sentence `No files were modified.`

Return a `WorkflowDefinition<CodingWorkflowState>` with exactly two steps:

1. `understand_request` copies the normalized objective and classification reason into evidence, then transitions to `inspect_and_explain`.
2. `inspect_and_explain` invokes the injected `CodingExecutor`. A completed executor result stores output/evidence and stops with the task-specific success reason. A stopped result forwards its status and reason.

- [ ] **Step 5: Implement coding-mode orchestration**

Create `src/modes/coding/run-coding-mode.ts` with:

```ts
export async function runCodingMode(input: {
  request: string;
  activeModel: string;
  tracePath: string;
  maxSteps: number;
  traceWriter: TraceWriter;
  classifier: CodingClassifier;
  executor: CodingExecutor;
  now?: () => string;
}): Promise<CodingRunResult>;
```

Normalize and reject an empty request before `coding_run_started`. After the start event, catch classifier errors, write `coding_run_stopped` with `classification_failed`, and return the failed result. On successful classification, write `coding_task_classified`, run the selected workflow, map its string reason to `CodingStopReason`, then write and return the terminal coding result. The final output comes from `workflowResult.state.output`.

The coordinator must not catch trace write failures. Use one helper to construct both the terminal event and return value so they cannot disagree.

- [ ] **Step 6: Run tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts
npm run build
```

Expected: all workflow cases and failure-path tests PASS; compilation succeeds.

- [ ] **Step 7: Commit coding workflows**

```bash
git add src/modes/coding/create-coding-workflow.ts src/modes/coding/run-coding-mode.ts src/trace/trace-event.ts tests/unit/coding-mode.test.ts
git commit -m "feat: add traced coding workflows"
```

---

### Task 6: Configured Coding Mode Composition and CLI Routing

**Files:**
- Create: `src/modes/coding/run-configured-coding-mode.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/cli-mode.test.ts`

**Interfaces:**
- Consumes: existing config loader, runner, terminal approval handler dependencies, coding tools/Agents, and `createRunTraceWriter`.
- Produces: `parseCliInvocation(args)`, `runConfiguredCodingMode(request, configPath?)`, and CLI dispatch.

- [ ] **Step 1: Write CLI parsing tests**

Create `tests/unit/cli-mode.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliInvocation } from "../../src/cli.js";

test("parses coding mode with natural-language input", () => {
  assert.deepEqual(
    parseCliInvocation(["coding", "帮我查看", "loop 模块代码"]),
    { mode: "coding", request: "帮我查看 loop 模块代码" },
  );
});

test("keeps the existing default loop invocation", () => {
  assert.deepEqual(
    parseCliInvocation(["Improve", "this task"]),
    { mode: "loop", request: "Improve this task" },
  );
});

test("rejects coding mode without a request", () => {
  assert.throws(
    () => parseCliInvocation(["coding"]),
    /Usage: npm run loop -- coding "your request"/,
  );
});
```

- [ ] **Step 2: Run the CLI test and verify it fails**

Run `./node_modules/.bin/tsx --test tests/unit/cli-mode.test.ts`.

Expected: FAIL because `parseCliInvocation` does not exist.

- [ ] **Step 3: Compose configured coding mode**

Create `src/modes/coding/run-configured-coding-mode.ts`. Follow `runConfiguredLoop` composition order:

1. disable SDK tracing;
2. load config and API key;
3. create one per-run trace and retain its `tracePath`;
4. create runner, tool runtime, outcome recorder, read-only coding tools, classifier Agent, and coding Agent;
5. call `runCodingMode` with injected classifier and executor closures.

Use `loaded.config.safetyLimits.maxSteps` for workflow steps and `maxTurns` for both Agent adapters. The executor closure builds a prompt containing the raw request, normalized objective, classification reason, and workflow instructions, then calls `runCodingAgent`.

Do not construct `createAgentTools`; use `createCodingTools` so no writable file tool reaches the coding Agent.

- [ ] **Step 4: Parse and dispatch CLI mode**

In `src/cli.ts`, export:

```ts
export type CliInvocation =
  | { mode: "loop"; request: string }
  | { mode: "coding"; request: string };

export function parseCliInvocation(args: string[]): CliInvocation;
```

If `args[0] === "coding"`, join `args.slice(1)`; otherwise join all args and preserve the existing usage failure. In `main`, call `runConfiguredCodingMode` for coding input and print its `CodingRunResult` as JSON. Keep existing loop JSON and exit-code behavior unchanged. Set exit code 1 only for `failed`; blocked/cancelled results remain structured non-success output without being mislabeled as runtime crashes.

- [ ] **Step 5: Run CLI tests, all unit tests, and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/cli-mode.test.ts
npm test
npm run build
```

Expected: CLI tests PASS, all offline unit tests PASS, and compilation succeeds.

- [ ] **Step 6: Commit CLI support**

```bash
git add src/modes/coding/run-configured-coding-mode.ts src/cli.ts tests/unit/cli-mode.test.ts
git commit -m "feat: route natural-language coding mode"
```

---

### Task 7: Documentation and End-to-End Contract Verification

**Files:**
- Modify: `README.md`
- Modify: `tests/unit/coding-mode.test.ts`

**Interfaces:**
- Consumes: public CLI and coding trace/result contracts from Tasks 1–6.
- Produces: user-facing coding-mode documentation and final regression evidence.

- [ ] **Step 1: Add a no-write regression assertion**

Extend the implementation-plan case in `tests/unit/coding-mode.test.ts` with an executor spy counter named `executionCalls`. Assert it is called once, the final output contains `No files were modified.`, the task type is `propose_implementation_plan`, and the stop reason is `implementation_plan_completed`. This proves the fallback is an executed read-only workflow rather than an unsupported-task shortcut.

- [ ] **Step 2: Run the focused test**

Run `./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts`.

Expected: PASS with all coding-mode cases, including the implementation-plan regression.

- [ ] **Step 3: Document coding mode**

Add a `## Coding mode` section to `README.md` containing:

```bash
npm run loop -- coding "帮我查看 loop 模块代码"
npm run loop -- coding "帮我查找 trace 相关文件"
npm run loop -- coding "帮我诊断 npm test 的失败"
npm run loop -- coding "帮我实现一个 login 页面"
```

Explain the three core task types and the implementation-plan fallback. State that the current milestone exposes only read, search, and permission-checked shell tools; it does not edit files. Document the result fields `status`, `taskType`, `stopReason`, `completedSteps`, `finalOutput`, and `tracePath`. List the four success stop reasons and explain that every coding run has its own structured JSONL trace.

- [ ] **Step 4: Run final verification**

Run:

```bash
npm test
npm run build
npm run test:integration
git diff --check
```

Expected:

- all offline unit tests PASS;
- TypeScript build succeeds;
- integration suite succeeds with live API cases skipped unless `RUN_LIVE_LOOP=1` is explicitly set;
- `git diff --check` prints no errors.

Do not run the paid live integration path unless the user explicitly requests it and supplies the intended credentials.

- [ ] **Step 5: Commit documentation and final regression**

```bash
git add README.md tests/unit/coding-mode.test.ts
git commit -m "docs: explain coding mode workflow"
```

---

## Execution Notes

- Execute tasks in order because each task's interfaces are consumed by later tasks.
- After every task, review only that task's diff before committing.
- Preserve unrelated working-tree changes and never stage them.
- If an implementation detail conflicts with an installed `@openai/agents` type, inspect the local SDK declaration and adapt only the Agent adapter; do not leak SDK types into `runtime/` or coding domain contracts.
- If a test exposes an actual defect, use `superpowers:systematic-debugging` before changing implementation behavior.
- Before declaring the feature complete, use `superpowers:verification-before-completion` and cite fresh command output.
