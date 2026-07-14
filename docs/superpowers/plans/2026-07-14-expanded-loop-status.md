# Expanded Loop Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 loop/act 状态，使授权拒绝、用户阻塞、不可恢复错误、继续迭代和真实成功得到不同终态，并消除“第三轮自动 completed”。

**Architecture:** Actor 使用 Agents SDK Zod `outputType` 返回结构化 outcome；run-scoped `ToolOutcomeRecorder` 从工具 wrapper 和审批协调层收集真实 ToolError，再由 `runAct()` 合并为 ActData。`runLoopStep()` 根据 terminal act outcome 直接进入 stop，确定性 verifier 只允许 succeeded 通过，StopDecision 将 blocked/cancelled/failed/completed 传播到 LoopStep、LoopState、trace 和 CLI。

**Tech Stack:** TypeScript 7、Node.js 22+、`@openai/agents` 0.13、Zod 4、`node:test`、JSONL trace。

## Global Constraints

- 使用 strict TypeScript、ESM `.js` import、双引号、分号和两个空格缩进。
- 重要逻辑添加解释设计意图、数据流、失败处理和边界条件的中文注释。
- 不新增 Reviewer Agent，不增加 API 调用，不改变 workspace 或 shell 权限策略。
- 每项行为先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 不修改或提交用户现有的 `config/loop.config.json`、`docs/context-packing-policy.md`、`package.json`、`package-lock.json` 改动。

---

## File Structure

- Create `src/domain/tool-error.ts`: provider-neutral ToolError、ToolErrorType、ToolEvidence。
- Create `src/agents/actor-output.ts`: Actor Zod outputType 及其推导类型。
- Create `src/agents/tools/tool-outcome-recorder.ts`: run-scoped 工具失败 checkpoint recorder。
- Modify `src/agents/tools/tool-result.ts`: 复用并兼容 re-export domain ToolError。
- Modify `src/agents/tools/trace-tool-execution.ts`: 失败结果同时写 recorder。
- Modify `src/agents/tools/create-agent-tools.ts`: 给三个工具注入共享 recorder。
- Modify `src/agents/tools/file-tool.ts`, `search-tool.ts`, `shell-tool.ts`: 传递 recorder。
- Modify `src/agents/create-agent.ts`: 注册结构化 outputType 和 outcome 指令。
- Modify `src/loop/stages/act.ts`: checkpoint、审批错误记录、结构化 finalOutput 和动态路由。
- Modify `src/domain/loop-step.ts`, `loop-state.ts`, `stop-decision.ts`: 扩展 outcome 与持久状态类型。
- Modify `src/loop/stages/verify.ts`, `stop.ts`, `src/loop/run-loop-step.ts`: 使用 act outcome 决定 verify/stop。
- Modify `src/trace/trace-event.ts`, `src/loop/loop-runner.ts`, `src/cli.ts`: 输出 `executedSteps` 并传播新终态。
- Modify `README.md`: 更新 CLI 状态与输出说明。
- Create/modify focused unit tests under `tests/unit/` for each behavior.

---

### Task 1: Domain Status and Structured Actor Output

**Files:**
- Create: `src/domain/tool-error.ts`
- Create: `src/agents/actor-output.ts`
- Modify: `src/agents/tools/tool-result.ts`
- Modify: `src/domain/loop-step.ts`
- Modify: `src/domain/loop-state.ts`
- Modify: `src/domain/stop-decision.ts`
- Test: `tests/unit/actor-output.test.ts`
- Test: `tests/unit/loop-state-status.test.ts`

**Interfaces:**
- Produces: `ToolError`, `ToolErrorType`, `ToolEvidence` from `src/domain/tool-error.ts`.
- Produces: `ACT_OUTCOMES`, `ActOutcome`, `LoopStatus`, expanded `StopReason` and `StopDecision`；ActData 字段在 Task 3 与 structured Actor output 一起切换。
- Produces: `actorOutputSchema` and `ActorOutput` for Agent/runAct.

- [ ] **Step 1: Write failing tests for the actor output schema and terminal statuses**

```ts
// tests/unit/actor-output.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { actorOutputSchema } from "../../src/agents/actor-output.js";

test("accepts every explicit actor outcome", () => {
  for (const outcome of [
    "succeeded",
    "continue",
    "failed",
    "blocked",
    "cancelled",
  ] as const) {
    assert.deepEqual(actorOutputSchema.parse({ output: "result", outcome }), {
      output: "result",
      outcome,
    });
  }
});

test("rejects empty or unstructured actor output", () => {
  assert.equal(actorOutputSchema.safeParse("done").success, false);
  assert.equal(
    actorOutputSchema.safeParse({ output: "", outcome: "succeeded" }).success,
    false,
  );
});
```

```ts
// tests/unit/loop-state-status.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LoopStatus } from "../../src/domain/loop-state.js";
import type { StopDecision } from "../../src/domain/stop-decision.js";

test("represents blocked and cancelled terminal loop decisions", () => {
  const statuses: LoopStatus[] = ["blocked", "cancelled"];
  const decisions: StopDecision[] = [
    { shouldStop: true, status: "blocked", reason: "approval_required" },
    { shouldStop: true, status: "cancelled", reason: "approval_rejected" },
  ];

  assert.deepEqual(statuses, ["blocked", "cancelled"]);
  assert.equal(decisions.every((decision) => decision.shouldStop), true);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/actor-output.test.ts tests/unit/loop-state-status.test.ts
```

Expected: FAIL because `actor-output.ts`, `LoopStatus`, blocked/cancelled StopDecision and expanded ActData do not exist.

- [ ] **Step 3: Add provider-neutral errors and expanded domain types**

```ts
// src/domain/tool-error.ts
export type ToolErrorType =
  | "invalid_input"
  | "path_outside_workspace"
  | "not_found"
  | "permission_denied"
  | "conflict"
  | "command_not_allowed"
  | "approval_required"
  | "approval_rejected"
  | "dependency_missing"
  | "timeout"
  | "process_failed"
  | "output_limit_exceeded"
  | "internal_error";

export type ToolEvidence = Record<
  string,
  string | number | boolean | null | string[]
>;

export interface ToolError {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  userActionRequired: boolean;
  suggestedNextStep: string;
  evidence: ToolEvidence;
}
```

Update `src/agents/tools/tool-result.ts` so existing imports remain compatible:

```ts
import type { ToolError } from "../../domain/tool-error.js";

export type {
  ToolError,
  ToolErrorType,
  ToolEvidence,
} from "../../domain/tool-error.js";

export type ToolResult<T> =
  | { ok: true; data: T; evidence: import("../../domain/tool-error.js").ToolEvidence }
  | { ok: false; error: ToolError };

export function createToolError(error: ToolError): ToolError {
  return error;
}
```

Add to `src/domain/loop-step.ts`:

```ts
export const ACT_OUTCOMES = [
  "succeeded",
  "continue",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type ActOutcome = (typeof ACT_OUTCOMES)[number];

export type LoopStepStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
```

Use `LoopStepStatus` for `LoopStep.status`. Add to `src/domain/loop-state.ts`:

```ts
export type LoopStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
```

Use `LoopStatus` for `LoopState.status`. Expand `StopReason` and terminal status in `src/domain/stop-decision.ts`:

```ts
export type StopReason =
  | "max_turns_exceeded"
  | "step_error"
  | "plan_condition_met"
  | "max_steps_exceeded"
  | "tool_error"
  | "action_failed"
  | "user_action_required"
  | "action_cancelled"
  | "approval_required"
  | "approval_rejected";

// shouldStop: true branch
status: "completed" | "failed" | "blocked" | "cancelled";
```

- [ ] **Step 4: Add the Zod actor output adapter**

```ts
// src/agents/actor-output.ts
import { z } from "zod";

import { ACT_OUTCOMES } from "../domain/loop-step.js";

export const actorOutputSchema = z.object({
  output: z.string().min(1),
  outcome: z.enum(ACT_OUTCOMES),
});

export type ActorOutput = z.infer<typeof actorOutputSchema>;
```

- [ ] **Step 5: Run focused tests and full type build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/actor-output.test.ts tests/unit/loop-state-status.test.ts
npm run build
```

Expected: focused tests PASS and TypeScript build PASS. ActData 尚未改变，因此本任务不会产生暂时不可编译的调用方。

- [ ] **Step 6: Commit domain types**

```bash
git add src/domain/tool-error.ts src/agents/actor-output.ts src/agents/tools/tool-result.ts src/domain/loop-step.ts src/domain/loop-state.ts src/domain/stop-decision.ts tests/unit/actor-output.test.ts tests/unit/loop-state-status.test.ts
git commit -m "feat: define expanded loop outcomes"
```

---

### Task 2: Run-Scoped Tool Failure Recorder

**Files:**
- Create: `src/agents/tools/tool-outcome-recorder.ts`
- Modify: `src/agents/tools/trace-tool-execution.ts`
- Modify: `src/agents/tools/create-agent-tools.ts`
- Modify: `src/agents/tools/file-tool.ts`
- Modify: `src/agents/tools/search-tool.ts`
- Modify: `src/agents/tools/shell-tool.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/tool-outcome-recorder.test.ts`
- Modify: `tests/unit/tool-trace.test.ts`

**Interfaces:**
- Consumes: `ToolError` from Task 1.
- Produces: `ToolOutcomeRecorder`, `createToolOutcomeRecorder()`.
- Changes: `traceToolExecution()` accepts optional `outcomeRecorder`; tool factories receive the shared recorder.
- Changes: CLI 创建唯一 run-scoped recorder 并传给 `createAgentTools()`；Task 3 再把同一对象传给 runAct。

- [ ] **Step 1: Write recorder and trace integration tests**

```ts
// tests/unit/tool-outcome-recorder.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import { createToolError } from "../../src/agents/tools/tool-result.js";

const first = createToolError({
  type: "timeout",
  message: "timed out",
  retryable: true,
  userActionRequired: false,
  suggestedNextStep: "retry once",
  evidence: { tool: "shell" },
});
const second = createToolError({
  type: "approval_rejected",
  message: "rejected",
  retryable: false,
  userActionRequired: false,
  suggestedNextStep: "use an alternative",
  evidence: { tool: "shell" },
});

test("returns only failures recorded after a checkpoint", () => {
  const recorder = createToolOutcomeRecorder();
  recorder.recordFailure(first);
  const checkpoint = recorder.checkpoint();
  recorder.recordFailure(second);

  assert.deepEqual(recorder.failuresSince(checkpoint), [second]);
  assert.equal(recorder.failuresSince(checkpoint)[0], second);
});
```

Extend the failure test in `tests/unit/tool-trace.test.ts`:

```ts
const outcomeRecorder = createToolOutcomeRecorder();
const checkpoint = outcomeRecorder.checkpoint();

const result = await traceToolExecution({
  tool: "shell",
  operation: "execute",
  inputSummary: { executable: "node", cwd: "." },
  traceWriter,
  now: sequence([
    "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:00:01.000Z",
  ]),
  clock: sequence([0, 1000]),
  outcomeRecorder,
  execute: async () => ({ ok: false, error }),
});

assert.deepEqual(outcomeRecorder.failuresSince(checkpoint), [error]);
```

Update each `createAgentTools()` call in `tests/unit/agent-tools.test.ts` to provide an isolated
recorder:

```ts
const outcomeRecorder = createToolOutcomeRecorder();
const tools = createAgentTools(runtime, traceWriter, outcomeRecorder);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/tool-outcome-recorder.test.ts tests/unit/tool-trace.test.ts
```

Expected: FAIL because recorder module and `outcomeRecorder` input do not exist.

- [ ] **Step 3: Implement the recorder**

```ts
// src/agents/tools/tool-outcome-recorder.ts
import type { ToolError } from "../../domain/tool-error.js";

export interface ToolOutcomeRecorder {
  checkpoint(): number;
  recordFailure(error: ToolError): void;
  failuresSince(checkpoint: number): ToolError[];
}

export function createToolOutcomeRecorder(): ToolOutcomeRecorder {
  const failures: ToolError[] = [];

  return {
    checkpoint: () => failures.length,
    recordFailure: (error) => failures.push(error),
    failuresSince: (checkpoint) => {
      if (
        !Number.isInteger(checkpoint) ||
        checkpoint < 0 ||
        checkpoint > failures.length
      ) {
        throw new RangeError("Invalid tool outcome checkpoint");
      }
      return failures.slice(checkpoint);
    },
  };
}
```

Validate checkpoint boundaries (`integer`, `>= 0`, `<= failures.length`) and throw `RangeError` for programmer misuse.

- [ ] **Step 4: Record the same ToolError used by trace and Agent**

Add to `TraceToolExecutionInput<T>`:

```ts
outcomeRecorder?: ToolOutcomeRecorder;
```

In the failure branch, before writing `tool_failed`:

```ts
input.outcomeRecorder?.recordFailure(result.error);
await input.traceWriter.write({
  event: "tool_failed",
  timestamp,
  tool: input.tool,
  operation: input.operation,
  durationMs,
  error: result.error,
});
```

Add required recorder parameters to the registry and each factory:

```ts
export function createAgentTools(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return [
    createFileTool(runtime, traceWriter, outcomeRecorder),
    createSearchTool(runtime, traceWriter, outcomeRecorder),
    createShellTool(runtime, traceWriter, outcomeRecorder),
  ];
}

type ToolFactory = (
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) => ReturnType<typeof tool>;
```

Change `createFileTool`, `createSearchTool` and `createShellTool` to satisfy this signature. In each
existing `traceToolExecution()` object, insert the recorder immediately after
`traceWriter` without changing its execute callback:

```ts
traceWriter,
outcomeRecorder,
execute: () => executeSearchTool(input, runtime),
```

The six required locations are file normal execution, file adapter failure, search normal execution,
search adapter failure, shell normal execution and shell adapter failure.

Create and inject the recorder in `src/cli.ts`:

```ts
const outcomeRecorder = createToolOutcomeRecorder();
const tools = createAgentTools(toolRuntime, traceWriter, outcomeRecorder);
```

- [ ] **Step 5: Run recorder, tool, and agent tool tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/tool-outcome-recorder.test.ts tests/unit/tool-trace.test.ts tests/unit/agent-tools.test.ts tests/unit/file-tool.test.ts tests/unit/search-tool.test.ts tests/unit/shell-tool.test.ts
npm run build
```

Expected: all selected tests PASS and TypeScript build PASS.

- [ ] **Step 6: Commit the recorder**

```bash
git add src/agents/tools/tool-outcome-recorder.ts src/agents/tools/trace-tool-execution.ts src/agents/tools/create-agent-tools.ts src/agents/tools/file-tool.ts src/agents/tools/search-tool.ts src/agents/tools/shell-tool.ts src/cli.ts tests/unit/tool-outcome-recorder.test.ts tests/unit/tool-trace.test.ts tests/unit/agent-tools.test.ts
git commit -m "feat: record run-scoped tool failures"
```

---

### Task 3: Structured Actor Output and Approval Recovery

**Files:**
- Modify: `src/agents/create-agent.ts`
- Modify: `src/domain/loop-step.ts`
- Modify: `src/loop/stages/act.ts`
- Modify: `src/cli.ts`
- Modify: `tests/unit/act-approval.test.ts`
- Modify: `tests/unit/step-decision.test.ts`

**Interfaces:**
- Consumes: `actorOutputSchema`, `ActorOutput`, `ToolOutcomeRecorder`.
- Produces: `createActorAgent()` returning an Agent with structured final output.
- Produces: `runAct()` returning ActData with runtime-owned `toolErrors` and outcome-driven StepDecision.

- [ ] **Step 1: Write failing approval fallback and terminal outcome tests**

Update the test actor and add a complete helper to `tests/unit/act-approval.test.ts`:

```ts
function actor(): ActorAgent {
  return Agent.create({
    name: "test actor",
    model: "test-model",
    instructions: "test",
    outputType: actorOutputSchema,
  });
}

async function runRejectedAct(
  finalOutput: ActorOutput,
  decision: "rejected" | "unavailable",
) {
  const item = approvalItem();
  const state = {
    approve: () => undefined,
    reject: () => undefined,
  };
  const results = [
    { interruptions: [item], state, finalOutput: undefined },
    { interruptions: [], state, finalOutput },
  ];
  const runner = {
    run: async () => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected runner call");
      return result;
    },
  } as unknown as Runner;

  return runAct({
    runner,
    agent: actor(),
    observation: {
      task: "complete safely",
      previousAction: null,
      previousReflection: null,
    },
    plan: {
      nextAction: "perform the operation",
      stopCondition: { description: "operation completes" },
    },
    maxTurns: 5,
    traceWriter: new MemoryTraceWriter(),
    outcomeRecorder: createToolOutcomeRecorder(),
    approvalHandler: async () => decision,
  });
}

test("allows a rejected command to recover through a successful alternative", async () => {
  const outcome = await runRejectedAct(
    { output: "used allowed alternative", outcome: "succeeded" },
    "rejected",
  );

  assert.equal(outcome.data.outcome, "succeeded");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_rejected");
  assert.equal(outcome.decision.nextStep, "verify");
});

test("routes a rejected command with no fallback directly to stop", async () => {
  const outcome = await runRejectedAct(
    {
      output: "user rejected the required operation",
      outcome: "cancelled",
    },
    "rejected",
  );

  assert.equal(outcome.data.outcome, "cancelled");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_rejected");
  assert.equal(outcome.decision.nextStep, "stop");
});

test("routes unavailable approval with no fallback to blocked", async () => {
  const outcome = await runRejectedAct(
    {
      output: "interactive approval is required",
      outcome: "blocked",
    },
    "unavailable",
  );

  assert.equal(outcome.data.outcome, "blocked");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_required");
  assert.equal(outcome.decision.nextStep, "stop");
});
```

- [ ] **Step 2: Run act tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/act-approval.test.ts tests/unit/step-decision.test.ts
```

Expected: FAIL because Agent output remains text, runAct does not accept recorder, ActData lacks toolErrors/outcome behavior, and terminal outcomes still route to verify.

- [ ] **Step 3: Configure the Actor for structured output**

Update `createActorAgent()`:

```ts
import { Agent, type Tool, type UnknownContext } from "@openai/agents";
import { actorOutputSchema } from "./actor-output.js";

export type ActorAgent = Agent<UnknownContext, typeof actorOutputSchema>;

export function createActorAgent(
  modelConfig: ModelConfig,
  tools: Tool[],
): ActorAgent {
  return Agent.create({
    name: "Loop Actor",
    model: modelConfig.model,
    outputType: actorOutputSchema,
    tools,
    instructions: [
      "You execute one concrete action in a larger engineering loop.",
      "Use the observation and plan supplied by the caller.",
      "Use workspace_file, workspace_search, and workspace_shell when local evidence or changes are required.",
      "Every local tool returns a ToolResult JSON object; on failure, use error.retryable, error.userActionRequired, error.suggestedNextStep, and error.evidence to decide what to do.",
      "Do not repeat a non-retryable call without changing its inputs or satisfying the requested user action.",
      "Return outcome=succeeded only when the objective is complete.",
      "Return outcome=continue when another loop iteration can make progress.",
      "Return failed, blocked, or cancelled only when no safe alternative remains.",
      "After a rejected command, try an allowed alternative before returning cancelled.",
      "Put the useful action result in output without discussing loop control.",
    ].join(" "),
  });
}
```

- [ ] **Step 4: Merge runtime failures into ActData**

Expand `ActData` in `src/domain/loop-step.ts` at the same time as its only production creator:

```ts
import type { ToolError } from "./tool-error.js";

export interface ActData {
  output: string;
  outcome: ActOutcome;
  toolErrors: ToolError[];
}
```

Change `ActInput.agent` to `ActorAgent` and add:

```ts
outcomeRecorder: ToolOutcomeRecorder;
```

At the beginning of `runAct()`:

```ts
const toolCheckpoint = input.outcomeRecorder.checkpoint();
```

When approval is rejected or unavailable, immediately after `approvalFailure()`:

```ts
input.outcomeRecorder.recordFailure(error);
```

Replace the text-only final output check with:

```ts
if (!result.finalOutput) {
  throw new Error("Agent returned no structured output");
}

const actorOutput = result.finalOutput as ActorOutput;
const terminal = ["failed", "blocked", "cancelled"].includes(
  actorOutput.outcome,
);

return {
  data: {
    output: actorOutput.output,
    outcome: actorOutput.outcome,
    toolErrors: input.outcomeRecorder.failuresSince(toolCheckpoint),
  },
  decision: {
    nextStep: terminal ? "stop" : "verify",
    reason: terminal ? "action_terminal" : "action_completed",
  },
};
```

Use a typed helper rather than an unsafe cast if SDK inference already exposes `ActorOutput` after `ActorAgent` is applied.

- [ ] **Step 5: Inject one recorder from CLI into tools and act**

Task 2 already created the recorder and passed it to tools. Pass that same object into the
`runAct()` dependency object:

```ts
runAct({
  runner,
  agent,
  observation,
  plan,
  maxTurns,
  traceWriter,
  approvalHandler,
  outcomeRecorder,
});
```

- [ ] **Step 6: Run act tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/act-approval.test.ts tests/unit/step-decision.test.ts tests/unit/agent-tools.test.ts
npm run build
```

Expected: approval fallback, cancelled and blocked tests PASS; build PASS.

- [ ] **Step 7: Commit structured act output**

```bash
git add src/agents/create-agent.ts src/domain/loop-step.ts src/loop/stages/act.ts src/cli.ts tests/unit/act-approval.test.ts tests/unit/step-decision.test.ts
git commit -m "feat: return structured action outcomes"
```

---

### Task 4: Outcome-Driven Verify and Stop State Machine

**Files:**
- Modify: `src/loop/stages/verify.ts`
- Modify: `src/loop/stages/stop.ts`
- Modify: `src/loop/run-loop-step.ts`
- Modify: `tests/unit/loop-step.test.ts`
- Modify: `tests/unit/stop.test.ts`
- Modify: `tests/unit/loop-runner.test.ts`

**Interfaces:**
- Consumes: expanded `ActData`, `ActOutcome`, ToolError types and StopDecision.
- Changes: `VerifyInput` receives `action: ActData`.
- Changes: `StopInput` receives `action: ActData | null` in addition to runtime failureReason.

- [ ] **Step 1: Write failing verifier and stop mapping tests**

Replace iteration-based verifier assertions with:

```ts
test("does not pass merely because this is the third iteration", async () => {
  const result = await runVerify({
    plan: {
      nextAction: "finish task",
      stopCondition: { description: "task is complete" },
    },
    action: { output: "not done", outcome: "continue", toolErrors: [] },
  });

  assert.equal(result.data.passed, false);
});

test("passes only a succeeded action", async () => {
  const result = await runVerify({
    plan: {
      nextAction: "finish task",
      stopCondition: { description: "task is complete" },
    },
    action: { output: "done", outcome: "succeeded", toolErrors: [] },
  });

  assert.equal(result.data.passed, true);
});
```

Add to `tests/unit/stop.test.ts` one table-driven test:

```ts
test("maps terminal action outcomes to distinct loop states", () => {
  const cases = [
    {
      action: {
        output: "blocked",
        outcome: "blocked" as const,
        toolErrors: [approvalRequiredError],
      },
      expected: {
        shouldStop: true,
        status: "blocked",
        reason: "approval_required",
      },
    },
    {
      action: {
        output: "cancelled",
        outcome: "cancelled" as const,
        toolErrors: [approvalRejectedError],
      },
      expected: {
        shouldStop: true,
        status: "cancelled",
        reason: "approval_rejected",
      },
    },
    {
      action: {
        output: "failed",
        outcome: "failed" as const,
        toolErrors: [processError],
      },
      expected: {
        shouldStop: true,
        status: "failed",
        reason: "tool_error",
      },
    },
  ];

  for (const item of cases) {
    assert.deepEqual(
      decideStop({
        stepIndex: 1,
        maxSteps: 3,
        verificationPassed: false,
        action: item.action,
      }),
      item.expected,
    );
  }
});
```

Also test generic `user_action_required`, `action_cancelled`, `action_failed`, and continue at/before maxSteps.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/loop-step.test.ts tests/unit/stop.test.ts tests/unit/loop-runner.test.ts
```

Expected: FAIL because verifier is still iteration-based and stop does not inspect action outcomes.

- [ ] **Step 3: Make verify deterministic on ActOutcome**

```ts
export interface VerifyInput {
  plan: PlanData;
  action: ActData;
}

export async function runVerify(
  input: VerifyInput,
): Promise<StepOutcome<VerifyData>> {
  const passed = input.action.outcome === "succeeded";
  return {
    data: {
      passed,
      evidence: passed
        ? `Action reports success for: ${input.plan.stopCondition.description}`
        : `Action outcome ${input.action.outcome} does not satisfy: ${input.plan.stopCondition.description}`,
    },
    decision: { nextStep: "reflect", reason: "verification_completed" },
  };
}
```

- [ ] **Step 4: Implement terminal stop mappings**

Add `action: ActData | null` to `StopInput`. Use helpers:

```ts
function hasToolError(action: ActData, type: ToolErrorType): boolean {
  return action.toolErrors.some((error) => error.type === type);
}
```

Before verification success and maxSteps checks:

```ts
if (input.action?.outcome === "blocked") {
  return {
    shouldStop: true,
    status: "blocked",
    reason: hasToolError(input.action, "approval_required")
      ? "approval_required"
      : "user_action_required",
  };
}

if (input.action?.outcome === "cancelled") {
  return {
    shouldStop: true,
    status: "cancelled",
    reason: hasToolError(input.action, "approval_rejected")
      ? "approval_rejected"
      : "action_cancelled",
  };
}

if (input.action?.outcome === "failed") {
  return {
    shouldStop: true,
    status: "failed",
    reason: input.action.toolErrors.length > 0
      ? "tool_error"
      : "action_failed",
  };
}
```

Keep runtime `failureReason` as the highest-priority branch.

- [ ] **Step 5: Pass ActData through runLoopStep and propagate step status**

Change verify invocation to:

```ts
runVerify({ plan: completedPlan, action: completedAction });
```

Pass `action` to `decideStop()`:

```ts
decideStop({
  stepIndex: step.index,
  maxSteps: input.maxSteps,
  verificationPassed: verification?.passed ?? false,
  failureReason,
  action,
});
```

Propagate terminal status:

```ts
step.status = stopExecution.data.shouldStop
  ? stopExecution.data.status
  : "completed";
```

Because terminal outcomes return `nextStep: "stop"`, existing pending-stage cleanup must mark verify and reflect skipped.

- [ ] **Step 6: Update loop tests for structured ActData**

Use explicit outcomes in mock executors:

```ts
act: async ({ observation }) => ({
  data: {
    output: `${observation.task} completed`,
    outcome: "succeeded",
    toolErrors: [],
  },
  decision: { nextStep: "verify", reason: "action_completed" },
}),
```

Add integration-style unit cases for blocked/cancelled and continue-to-maxSteps, asserting LoopState, last LoopStep status, skipped stages and stop reason.

- [ ] **Step 7: Run state-machine tests and build**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/loop-step.test.ts tests/unit/stop.test.ts tests/unit/loop-runner.test.ts tests/unit/step-decision.test.ts tests/unit/act-approval.test.ts
npm run build
```

Expected: all selected tests PASS; build PASS.

- [ ] **Step 8: Commit outcome-driven state machine**

```bash
git add src/loop/stages/verify.ts src/loop/stages/stop.ts src/loop/run-loop-step.ts tests/unit/loop-step.test.ts tests/unit/stop.test.ts tests/unit/loop-runner.test.ts tests/unit/step-decision.test.ts
git commit -m "feat: propagate terminal loop statuses"
```

---

### Task 5: Accurate CLI and Trace Summary

**Files:**
- Modify: `src/trace/trace-event.ts`
- Modify: `src/loop/loop-runner.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Create: `tests/unit/cli-summary.test.ts`
- Modify: `tests/unit/loop-runner.test.ts`
- Modify: `tests/unit/trace-writer.test.ts`

**Interfaces:**
- Produces: `createLoopSummary(state)` with `executedSteps`.
- Changes: `LoopStoppedEvent.completedSteps` to `executedSteps`.
- Changes: failed/blocked/cancelled CLI exit code is nonzero.

- [ ] **Step 1: Write failing summary and trace field tests**

```ts
// tests/unit/cli-summary.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLoopSummary } from "../../src/cli.js";
import { createLoopState } from "../../src/loop/create-loop-state.js";

test("reports executed steps without calling them completed", () => {
  const state = createLoopState("task", "gpt", "2026-07-14T00:00:00.000Z");
  state.status = "blocked";
  state.stopReason = "approval_required";
  state.steps.push({} as never);

  const summary = createLoopSummary(state);

  assert.equal(summary.status, "blocked");
  assert.equal(summary.executedSteps, 1);
  assert.equal("completedSteps" in summary, false);
});
```

In loop-runner test, inspect `loop_stopped`:

```ts
const stopped = traceWriter.events.find(
  (event) => event.event === "loop_stopped",
);
assert.equal(stopped?.event, "loop_stopped");
if (stopped?.event === "loop_stopped") {
  assert.equal(stopped.executedSteps, state.steps.length);
  assert.equal("completedSteps" in stopped, false);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/cli-summary.test.ts tests/unit/loop-runner.test.ts tests/unit/trace-writer.test.ts
```

Expected: FAIL because `createLoopSummary` and `executedSteps` do not exist.

- [ ] **Step 3: Rename the trace field and extract CLI summary creation**

Change `LoopStoppedEvent` and `runLoop()` to use:

```ts
executedSteps: state.steps.length,
```

Add to `src/cli.ts`:

```ts
export function createLoopSummary(state: LoopState) {
  return {
    status: state.status,
    stopReason: state.stopReason,
    executedSteps: state.steps.length,
    finalOutput: state.steps.at(-1)?.act.data?.output ?? null,
  };
}
```

Use it in `main()`:

```ts
console.log(JSON.stringify(createLoopSummary(state), null, 2));
if (state.status !== "completed") process.exitCode = 1;
```

- [ ] **Step 4: Update fixtures and README**

Replace the trace fixture field:

```ts
const event: TraceEvent = {
  event: "loop_stopped",
  timestamp: "2026-07-14T10:00:00.000Z",
  status: "completed",
  stopReason: "plan_condition_met",
  executedSteps: 3,
};
```

Update the README CLI example to:

```json
{
  "status": "completed",
  "stopReason": "plan_condition_met",
  "executedSteps": 1,
  "finalOutput": "Task completed with verified evidence."
}
```

Replace the skeleton wording with this status contract:

```text
Actor returns succeeded → verify passes → completed
Actor returns continue → run another LoopStep until maxSteps
Actor returns failed → failed
Actor returns blocked → blocked
Actor returns cancelled → cancelled
```

State explicitly that `executedSteps` counts recorded iterations, and that only completed exits with
code 0; failed, blocked and cancelled exit nonzero.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/cli-summary.test.ts tests/unit/loop-runner.test.ts tests/unit/trace-writer.test.ts
npm test
npm run build
npm run test:integration
git diff --check
```

Expected:

- Focused tests PASS.
- All unit tests PASS with zero failures.
- TypeScript build PASS.
- Default integration command PASS with the live paid test skipped.
- `git diff --check` emits no output.

- [ ] **Step 6: Commit summary semantics and documentation**

```bash
git add src/trace/trace-event.ts src/loop/loop-runner.ts src/cli.ts README.md tests/unit/cli-summary.test.ts tests/unit/loop-runner.test.ts tests/unit/trace-writer.test.ts
git commit -m "feat: report accurate loop terminal states"
```

---

### Task 6: Final Regression Review

**Files:**
- Review: all files changed by Tasks 1-5
- Test: all `tests/unit/*.test.ts`

**Interfaces:**
- Verifies the spec acceptance criteria without adding new behavior.

- [ ] **Step 1: Inspect only feature changes and preserve unrelated user edits**

Run:

```bash
git status --short
git diff 1f70be4..HEAD --stat
git diff 1f70be4..HEAD -- src tests README.md
```

Expected: feature commits contain only planned files; pre-existing config/package/context-policy edits remain unstaged and uncommitted.

- [ ] **Step 2: Run the complete verification suite again**

Run:

```bash
npm test
npm run build
npm run test:integration
git diff --check
```

Expected: unit tests and build pass; default integration passes with live test skipped; diff check is clean.

- [ ] **Step 3: Request code review**

Review range:

```text
1f70be4..HEAD
```

Reviewer must check terminal state precedence, recorder checkpoint isolation, approval fallback semantics, structured SDK output typing, skipped-stage behavior, CLI exit codes, trace compatibility and accidental inclusion of unrelated user changes.

- [ ] **Step 4: Fix any Critical/Important findings with a new RED-GREEN cycle**

For each accepted finding, add one focused regression test, run it to observe the expected failure, implement the smallest fix, rerun the focused test and full suite, then commit with:

```bash
git commit -m "fix: harden expanded loop statuses"
```

- [ ] **Step 5: Confirm final repository state**

Run:

```bash
git status --short
git log --oneline 1f70be4..HEAD
```

Expected: only the user's pre-existing unrelated files remain modified; all expanded-status implementation work is committed on the selected branch.
