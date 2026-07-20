# Reviewer Subagent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现遵循现有 `SubagentContract/SubagentResult` 协议的无工具 reviewer-agent，并把 Coding workflow 扩展为可追溯、受 `maxSteps` 限制的 executor → reviewer → pass/revise/ask_user 闭环。

**Architecture:** 新增 provider-neutral `runSubagent()`，负责 contract/result 校验、timeout、max-step 错误归一化和 subagent trace；Reviewer SDK adapter 只负责一次无工具模型调用。Coding composition 使用 recording trace writer 生成已持久化事件快照，workflow 将校验后的 reviewer recommendation 映射为 transition，reviewer 本身不拥有 workflow。

**Tech Stack:** TypeScript 7、Node.js 22、ESM、Zod 4、OpenAI Agents SDK 0.13、`node:test`、`node:assert/strict`。

## Global Constraints

- 使用 strict TypeScript、双引号、分号、两空格缩进和带 `.js` 后缀的 ESM import。
- 重要逻辑添加详细中文注释，解释设计意图、数据流、失败处理和边界条件。
- reviewer 的 contract `allowedTools` 与 SDK `tools` 都必须精确为空数组。
- reviewer 只消费调用前已持久化的 trace 快照和当前 executor summary。
- reviewer recommendation 不包含 `WorkflowTransition`、整体 status 或 stop reason；coordinator 拥有最终路由。
- trace/context 超限不得静默裁剪；trace writer 失败必须 reject。
- 不实现真实 search-agent、test-agent、并发、handoff、重试队列或持久 RunState。
- 不修改普通七阶段 Loop 的阶段顺序、步数语义或停止规则。
- 不运行付费 live integration。

## File Structure

- Create `src/trace/recording-trace-writer.ts`: 装饰持久 writer，并只快照已写入成功的事件。
- Modify `src/trace/trace-event.ts`: 增加 coding execution 和通用 subagent 生命周期事件。
- Create `src/subagents/subagent-invoker.ts`: 定义 provider-neutral invoker、输入和 max-step 错误。
- Create `src/subagents/run-subagent.ts`: 实施 timeout、统一结果校验、失败归一化和 trace。
- Create `src/subagents/reviewer/reviewer-contract.ts`: 动态 reviewer contract、extension schema 和 trace-reference 校验。
- Create `src/subagents/reviewer/create-reviewer-agent.ts`: 创建无工具结构化 SDK Agent。
- Create `src/subagents/reviewer/run-reviewer-agent.ts`: 将 Runner 映射到 `SubagentInvoker`。
- Modify `src/subagents/examples/reviewer-agent-example.ts`: 让静态示例使用新的 reviewer extension。
- Modify `src/modes/coding/coding-state.ts`: 增加 reviewer、attempt 和 revision feedback 类型。
- Modify `src/modes/coding/create-coding-workflow.ts`: 实现 executor/reviewer attempt 和 decision 映射。
- Modify `src/modes/coding/run-coding-mode.ts`: 注入 reviewer 与 trace snapshot，映射新增 stop reasons。
- Modify `src/modes/coding/run-configured-coding-mode.ts`: 组装 recording writer、reviewer contract/runtime 和 SDK adapter。
- Create `tests/unit/recording-trace-writer.test.ts`: 验证持久化成功边界。
- Create `tests/unit/reviewer-contract.test.ts`: 验证三项检查、decision 组合和 trace 引用。
- Create `tests/unit/subagent-runtime.test.ts`: 验证通用运行层成功、timeout、错误和 trace。
- Create `tests/unit/reviewer-agent.test.ts`: 验证无工具 Agent 与 Runner adapter。
- Modify `tests/unit/subagent-contract.test.ts`: 更新 reviewer 示例回归。
- Modify `tests/unit/coding-mode.test.ts`: 覆盖 pass、revise、ask_user 和 reviewer failure。
- Modify `README.md`: 说明 reviewer 闭环、无工具边界和终态。

---

### Task 1: Recording Trace Writer

**Files:**
- Create: `src/trace/recording-trace-writer.ts`
- Create: `tests/unit/recording-trace-writer.test.ts`

**Interfaces:**
- Consumes: `TraceWriter.write(event: TraceEvent): Promise<void>`。
- Produces: `RecordingTraceWriter`，包含 `write(event)` 与 `snapshot(): readonly TraceEvent[]`。

- [ ] **Step 1: Write the failing persistence-boundary tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { RecordingTraceWriter } from "../../src/trace/recording-trace-writer.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

const event: TraceEvent = {
  event: "coding_run_started",
  timestamp: "2026-07-20T00:00:00.000Z",
  request: "review it",
  mode: "coding",
  activeModel: "test-model",
};

test("records an event only after the downstream writer succeeds", async () => {
  const persisted: TraceEvent[] = [];
  const writer = new RecordingTraceWriter({
    write: async (value) => { persisted.push(value); },
  });

  await writer.write(event);

  assert.deepEqual(persisted, [event]);
  assert.deepEqual(writer.snapshot(), [event]);
  assert.notEqual(writer.snapshot(), writer.snapshot());
});

test("does not expose an event rejected by the downstream writer", async () => {
  const writer = new RecordingTraceWriter({
    write: async () => { throw new Error("trace unavailable"); },
  });

  await assert.rejects(writer.write(event), /trace unavailable/);
  assert.deepEqual(writer.snapshot(), []);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/recording-trace-writer.test.ts`

Expected: FAIL with `Cannot find module '../../src/trace/recording-trace-writer.js'`.

- [ ] **Step 3: Implement the minimal decorator**

```ts
import type { TraceEvent } from "./trace-event.js";
import type { TraceWriter } from "./jsonl-trace-writer.js";

export class RecordingTraceWriter implements TraceWriter {
  private readonly events: TraceEvent[] = [];

  public constructor(private readonly downstream: TraceWriter) {}

  public async write(event: TraceEvent): Promise<void> {
    // 先持久化再加入内存，保证 snapshot 下标始终能映射到真实 JSONL 事件。
    await this.downstream.write(event);
    this.events.push(event);
  }

  public snapshot(): readonly TraceEvent[] {
    // 返回新的数组，调用方不能通过数组操作改写 writer 的内部顺序。
    return [...this.events];
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/recording-trace-writer.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit the independently testable trace journal**

```bash
git add src/trace/recording-trace-writer.ts tests/unit/recording-trace-writer.test.ts
git commit -m "feat: add recording trace writer"
```

---

### Task 2: Reviewer Contract and Trace-Reference Validation

**Files:**
- Create: `src/subagents/reviewer/reviewer-contract.ts`
- Create: `tests/unit/reviewer-contract.test.ts`
- Modify: `src/subagents/examples/reviewer-agent-example.ts`
- Modify: `tests/unit/subagent-contract.test.ts`

**Interfaces:**
- Consumes: `SubagentContract`, `SubagentResult`, `validateSubagentResult()` and `TraceEvent`。
- Produces: `REVIEW_CRITERIA`, `reviewerAgentExtensionsSchema`, `createReviewerAgentContract()`, `validateReviewerAgentCompletedResult()`, `ReviewerAgentExtensions`, `ReviewerAgentCompletedResult`。

- [ ] **Step 1: Write failing tests for contract construction and valid decisions**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReviewerAgentContract,
  validateReviewerAgentCompletedResult,
} from "../../src/subagents/reviewer/reviewer-contract.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

const trace: TraceEvent[] = [{
  event: "coding_run_started",
  timestamp: "2026-07-20T00:00:00.000Z",
  request: "explain loop",
  mode: "coding",
  activeModel: "test-model",
}];

const passExtensions = {
  decision: "pass" as const,
  checks: [
    { criterion: "conclusion_evidence" as const, status: "passed" as const, summary: "Claims cite trace.", traceReferences: [0] },
    { criterion: "failure_disclosure" as const, status: "passed" as const, summary: "No failure was omitted.", traceReferences: [0] },
    { criterion: "required_validation" as const, status: "passed" as const, summary: "Required validation is present.", traceReferences: [0] },
  ],
  revisionInstructions: [],
};

test("builds a tool-free reviewer contract from trace and summary", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });

  assert.equal(contract.id, "review-coding-attempt-1");
  assert.deepEqual(contract.allowedTools, []);
  assert.deepEqual(contract.scope.include, ["traces"]);
  assert.deepEqual(contract.contextPackage.items.map((item) => item.id), [
    "coding-trace",
    "executor-summary",
  ]);
});

test("validates a completed pass result and its trace references", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });
  const result = {
    contractId: contract.id,
    role: "reviewer-agent" as const,
    status: "completed" as const,
    summary: "The summary passes review.",
    evidence: [
      { kind: "review_decision", source: contract.id, summary: "pass" },
      { kind: "trace_reference", source: "coding-trace", summary: "Referenced trace index 0." },
    ],
    errors: [],
    extensions: passExtensions,
  };

  assert.deepEqual(
    validateReviewerAgentCompletedResult(contract, result, trace.length),
    result,
  );
});
```

- [ ] **Step 2: Add failing invariant cases**

Add tests that clone `passExtensions` and assert throws for:

```ts
assert.throws(() => validateReviewerAgentCompletedResult(contract, {
  ...result,
  extensions: { ...passExtensions, checks: passExtensions.checks.slice(0, 2) },
}, trace.length));

assert.throws(() => validateReviewerAgentCompletedResult(contract, {
  ...result,
  extensions: {
    ...passExtensions,
    checks: passExtensions.checks.map((check, index) =>
      index === 0 ? { ...check, traceReferences: [trace.length] } : check),
  },
}, trace.length));

assert.throws(() => validateReviewerAgentCompletedResult(contract, {
  ...result,
  extensions: {
    ...passExtensions,
    decision: "revise",
    revisionInstructions: [],
  },
}, trace.length));

assert.throws(() => validateReviewerAgentCompletedResult(contract, {
  ...result,
  extensions: {
    ...passExtensions,
    decision: "ask_user",
    userQuestion: undefined,
  },
}, trace.length));
```

Also test that `createReviewerAgentContract({ ..., maxChars: 1 })` throws instead of truncating context.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/reviewer-contract.test.ts`

Expected: FAIL because `reviewer-contract.js` does not exist.

- [ ] **Step 4: Implement the schemas, factory, and cross-object validator**

Implement `src/subagents/reviewer/reviewer-contract.ts` with these exact exports and invariants:

```ts
import { z } from "zod";

import {
  subagentContractSchema,
  validateSubagentResult,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";
import type { TraceEvent } from "../../trace/trace-event.js";

export const REVIEW_CRITERIA = [
  "conclusion_evidence",
  "failure_disclosure",
  "required_validation",
] as const;

const reviewerCheckSchema = z.object({
  criterion: z.enum(REVIEW_CRITERIA),
  status: z.enum(["passed", "failed", "needs_user"]),
  summary: z.string().min(1),
  traceReferences: z.array(z.number().int().nonnegative()).min(1),
}).strict();

export const reviewerAgentExtensionsSchema = z.object({
  decision: z.enum(["pass", "revise", "ask_user"]),
  checks: z.array(reviewerCheckSchema).length(REVIEW_CRITERIA.length),
  revisionInstructions: z.array(z.string().min(1)),
  userQuestion: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  const criteria = value.checks.map((check) => check.criterion);
  for (const criterion of REVIEW_CRITERIA) {
    if (criteria.filter((value) => value === criterion).length !== 1) {
      context.addIssue({ code: "custom", path: ["checks"], message: `criterion must appear exactly once: ${criterion}` });
    }
  }

  if (value.decision === "pass") {
    if (value.checks.some((check) => check.status !== "passed")) {
      context.addIssue({ code: "custom", path: ["decision"], message: "pass requires every check to pass" });
    }
    if (value.revisionInstructions.length > 0 || value.userQuestion !== undefined) {
      context.addIssue({ code: "custom", path: ["decision"], message: "pass cannot request revision or user input" });
    }
  }

  if (value.decision === "revise") {
    if (!value.checks.some((check) => check.status === "failed") || value.revisionInstructions.length === 0) {
      context.addIssue({ code: "custom", path: ["decision"], message: "revise requires a failed check and instructions" });
    }
    if (value.userQuestion !== undefined) {
      context.addIssue({ code: "custom", path: ["userQuestion"], message: "revise cannot ask the user" });
    }
  }

  if (value.decision === "ask_user") {
    if (!value.checks.some((check) => check.status === "needs_user") || value.userQuestion === undefined) {
      context.addIssue({ code: "custom", path: ["decision"], message: "ask_user requires a needs_user check and question" });
    }
    if (value.revisionInstructions.length > 0) {
      context.addIssue({ code: "custom", path: ["revisionInstructions"], message: "ask_user cannot also request executor revision" });
    }
  }
});

export type ReviewerAgentExtensions = z.infer<typeof reviewerAgentExtensionsSchema>;
export type ReviewerAgentCompletedResult = Omit<SubagentResult, "status" | "extensions"> & {
  status: "completed";
  extensions: ReviewerAgentExtensions;
};
export type ReviewerAgentUnsuccessfulResult = Omit<SubagentResult, "status"> & {
  status: "failed" | "blocked" | "timed_out";
};
export type ReviewerAgentRunResult =
  | ReviewerAgentCompletedResult
  | ReviewerAgentUnsuccessfulResult;

export function createReviewerAgentContract(input: {
  attempt: number;
  trace: readonly TraceEvent[];
  summary: string;
  maxChars?: number;
  timeoutMs?: number;
  maxSteps?: number;
}): SubagentContract {
  const contextPackage = {
    items: [
      { id: "coding-trace", kind: "trace", source: "runtime", content: JSON.stringify(input.trace) },
      { id: "executor-summary", kind: "summary", source: "executor", content: input.summary },
    ],
    maxChars: input.maxChars ?? 100_000,
  };

  return subagentContractSchema.parse({
    id: `review-coding-attempt-${input.attempt}`,
    role: "reviewer-agent",
    task: "Review the executor summary against the supplied trace.",
    scope: { include: ["traces"], exclude: [], constraints: ["Use only context items; do not execute tools or modify files."] },
    allowedTools: [],
    contextPackage,
    expectedOutput: { format: "subagent-result", requirements: ["Return pass, revise, or ask_user with three trace-backed checks."] },
    evidenceRequirements: { requiredKinds: ["review_decision", "trace_reference"], minimumCount: 2 },
    limits: { timeoutMs: input.timeoutMs ?? 15_000, maxSteps: input.maxSteps ?? 8 },
  });
}

export function validateReviewerAgentCompletedResult(
  contract: SubagentContract,
  result: unknown,
  traceLength: number,
): ReviewerAgentCompletedResult {
  const validated = validateSubagentResult(contract, result);
  if (validated.status !== "completed") {
    throw new Error("Reviewer result is not completed");
  }
  const extensions = reviewerAgentExtensionsSchema.parse(validated.extensions);
  for (const check of extensions.checks) {
    if (check.traceReferences.some((reference) => reference >= traceLength)) {
      throw new Error("Reviewer trace reference is outside the frozen snapshot");
    }
  }
  return { ...validated, status: "completed", extensions };
}
```

- [ ] **Step 5: Replace the reviewer example with a valid no-tool pass fixture**

Update `src/subagents/examples/reviewer-agent-example.ts` to import `reviewerAgentExtensionsSchema`, use `allowedTools: []`, `include: ["traces"]`, the two required evidence kinds, and the same three `passed` checks referencing trace index `0`. Re-export the imported schema so existing consumers continue importing it from the example module.

- [ ] **Step 6: Run reviewer and shared contract tests**

Run: `./node_modules/.bin/tsx --test tests/unit/reviewer-contract.test.ts tests/unit/subagent-contract.test.ts`

Expected: PASS. The existing search/test fixtures remain unchanged and valid.

- [ ] **Step 7: Commit the reviewer protocol**

```bash
git add src/subagents/reviewer/reviewer-contract.ts src/subagents/examples/reviewer-agent-example.ts tests/unit/reviewer-contract.test.ts tests/unit/subagent-contract.test.ts
git commit -m "feat: define reviewer subagent decisions"
```

---

### Task 3: Generic Subagent Runtime and Lifecycle Trace

**Files:**
- Create: `src/subagents/subagent-invoker.ts`
- Create: `src/subagents/run-subagent.ts`
- Modify: `src/trace/trace-event.ts`
- Create: `tests/unit/subagent-runtime.test.ts`

**Interfaces:**
- Consumes: `SubagentContract`, `SubagentResult`, `validateSubagentResult()`, `TraceWriter`。
- Produces: `SubagentInvoker`, `SubagentInvocationInput`, `SubagentMaxStepsExceededError`, `runSubagent()`。

- [ ] **Step 1: Add the new trace event shapes before using them in tests**

Add to `src/trace/trace-event.ts`:

```ts
import type {
  AllowedSubagentTool,
  SubagentResult,
  SubagentRole,
} from "../domain/subagent-contract.js";

export interface CodingExecutionCompletedEvent {
  event: "coding_execution_completed";
  timestamp: string;
  attempt: number;
  summary: string;
  evidence: WorkflowEvidence[];
}

export interface SubagentStartedEvent {
  event: "subagent_started";
  timestamp: string;
  contractId: string;
  role: SubagentRole;
  contextItemIds: string[];
  allowedTools: AllowedSubagentTool[];
  limits: { timeoutMs: number; maxSteps: number };
}

export interface SubagentFinishedEvent {
  event: "subagent_finished";
  timestamp: string;
  result: SubagentResult;
}
```

Add all three interfaces to `TraceEvent`.

- [ ] **Step 2: Write failing runtime tests for success, timeout, invalid result, and trace failure**

Create `tests/unit/subagent-runtime.test.ts` with a valid reviewer contract/result helper and these assertions:

```ts
test("passes contract capabilities and budgets to the invoker", async () => {
  const received: SubagentInvocationInput[] = [];
  const result = await runSubagent({
    contract,
    traceWriter,
    now: () => "2026-07-20T00:00:00.000Z",
    invoker: async (input) => { received.push(input); return validResult; },
  });

  assert.deepEqual(result, validResult);
  assert.deepEqual(received[0]?.allowedTools, []);
  assert.equal(received[0]?.maxSteps, contract.limits.maxSteps);
  assert.equal(received[0]?.signal.aborted, false);
  assert.deepEqual(traceWriter.events.map((event) => event.event), [
    "subagent_started",
    "subagent_finished",
  ]);
});

test("aborts and returns timed_out when the invocation exceeds timeoutMs", async () => {
  const shortContract = { ...contract, limits: { ...contract.limits, timeoutMs: 5 } };
  const result = await runSubagent({
    contract: shortContract,
    traceWriter,
    invoker: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(validResult), { once: true });
    }),
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.errors[0]?.code, "subagent_timeout");
});

test("normalizes invalid model output instead of accepting success", async () => {
  const result = await runSubagent({ contract, traceWriter, invoker: async () => "pass" });
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0]?.code, "subagent_invalid_result");
});

test("does not swallow lifecycle trace failures", async () => {
  await assert.rejects(runSubagent({
    contract,
    traceWriter: { write: async () => { throw new Error("trace unavailable"); } },
    invoker: async () => validResult,
  }), /trace unavailable/);
});
```

Also add a case where invoker throws `new SubagentMaxStepsExceededError()` and assert `subagent_max_steps_exceeded`.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/subagent-runtime.test.ts`

Expected: FAIL because `run-subagent.js` and `subagent-invoker.js` do not exist.

- [ ] **Step 4: Define the provider-neutral invoker**

```ts
import type { AllowedSubagentTool } from "../domain/subagent-contract.js";

export interface SubagentInvocationInput {
  prompt: string;
  allowedTools: AllowedSubagentTool[];
  maxSteps: number;
  signal: AbortSignal;
}

export type SubagentInvoker = (input: SubagentInvocationInput) => Promise<unknown>;

export class SubagentMaxStepsExceededError extends Error {
  public constructor() {
    super("Subagent exceeded maxSteps");
    this.name = "SubagentMaxStepsExceededError";
  }
}
```

- [ ] **Step 5: Implement `runSubagent()` with a real timeout race**

Implement `src/subagents/run-subagent.ts`. Use this signature and control flow:

```ts
export async function runSubagent(input: {
  contract: unknown;
  invoker: SubagentInvoker;
  traceWriter: TraceWriter;
  validateCompletedResult?: (
    contract: SubagentContract,
    result: SubagentResult,
  ) => SubagentResult;
  now?: () => string;
}): Promise<SubagentResult>
```

Required helpers:

```ts
function createFailure(
  contract: SubagentContract,
  status: "failed" | "timed_out",
  code: string,
  message: string,
): SubagentResult {
  return validateSubagentResult(contract, {
    contractId: contract.id,
    role: contract.role,
    status,
    summary: message,
    evidence: [],
    errors: [{ code, message, retryable: false }],
  });
}

function compilePrompt(contract: SubagentContract): string {
  return [
    `Contract ID: ${contract.id}`,
    `Role: ${contract.role}`,
    `Task: ${contract.task}`,
    `Constraints:\n${contract.scope.constraints.join("\n")}`,
    `Expected output:\n${contract.expectedOutput.requirements.join("\n")}`,
    ...contract.contextPackage.items.map((item) =>
      `Context item ${item.id} (${item.kind}, source=${item.source}):\n${item.content}`),
  ].join("\n\n");
}
```

Inside `runSubagent()`:

1. Parse contract with `subagentContractSchema` before writing trace.
2. Write `subagent_started` without context content.
3. Create `AbortController` and `Promise.race()` between invoker and a timer rejection.
4. Pass copied `allowedTools`, `maxSteps`, signal and compiled prompt.
5. Clear timer in `finally`.
6. Map timeout, `SubagentMaxStepsExceededError`, and other invocation exceptions to safe failure results.
7. Validate raw output with `validateSubagentResult`; on completed output call `validateCompletedResult` when present.
8. Convert schema/role validation failures to `subagent_invalid_result`.
9. Write `subagent_finished` with the final validated result and return it.

Do not wrap either trace write in the invocation `try/catch`.

- [ ] **Step 6: Run the focused runtime tests**

Run: `./node_modules/.bin/tsx --test tests/unit/subagent-runtime.test.ts`

Expected: PASS for success, timeout, max steps, invalid output, invocation failure and trace failure.

- [ ] **Step 7: Run the build to catch TraceEvent union mistakes**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 8: Commit the generic runtime**

```bash
git add src/subagents/subagent-invoker.ts src/subagents/run-subagent.ts src/trace/trace-event.ts tests/unit/subagent-runtime.test.ts
git commit -m "feat: run validated subagents"
```

---

### Task 4: Tool-Free Reviewer SDK Adapter

**Files:**
- Create: `src/subagents/reviewer/create-reviewer-agent.ts`
- Create: `src/subagents/reviewer/run-reviewer-agent.ts`
- Create: `tests/unit/reviewer-agent.test.ts`

**Interfaces:**
- Consumes: `ModelConfig`, Agents SDK `Agent`, `Runner`, `MaxTurnsExceededError`, `subagentResultSchema`, `SubagentInvoker`。
- Produces: `ReviewerAgent`, `createReviewerAgent(modelConfig)`, `runReviewerAgent(input)`。

- [ ] **Step 1: Write failing tests for the no-tool factory and Runner mapping**

```ts
test("creates a structured reviewer with no tools", () => {
  const agent = createReviewerAgent(modelConfig);
  assert.deepEqual(agent.tools, []);
  assert.match(String(agent.instructions), /conclusion.*evidence/i);
  assert.match(String(agent.instructions), /failure/i);
  assert.match(String(agent.instructions), /required validation/i);
  assert.match(String(agent.instructions), /must not.*tool/i);
});

test("passes maxSteps and signal to Runner", async () => {
  const controller = new AbortController();
  let options: unknown;
  const runner = {
    run: async (_agent: unknown, _prompt: unknown, received: unknown) => {
      options = received;
      return { finalOutput: validResult, interruptions: [] };
    },
  } as unknown as Runner;

  assert.deepEqual(await runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: [],
    maxSteps: 4,
    signal: controller.signal,
  }), validResult);
  assert.deepEqual(options, { maxTurns: 4, signal: controller.signal });
});
```

Add cases asserting that non-empty `allowedTools`, interruptions, missing final output, and SDK `MaxTurnsExceededError` are rejected; the last must throw `SubagentMaxStepsExceededError`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/reviewer-agent.test.ts`

Expected: FAIL because reviewer Agent modules do not exist.

- [ ] **Step 3: Implement the no-tool Agent factory**

```ts
import { Agent } from "@openai/agents";
import type { ModelConfig } from "../../config/config-schema.js";
import { subagentResultSchema } from "../../domain/subagent-contract.js";

export type ReviewerAgent = Agent<unknown, typeof subagentResultSchema>;

export function createReviewerAgent(modelConfig: ModelConfig): ReviewerAgent {
  return Agent.create({
    name: "Trace-only Reviewer Subagent",
    model: modelConfig.model,
    outputType: subagentResultSchema,
    instructions: [
      "Review only the supplied trace and executor summary.",
      "Check whether every important conclusion has evidence, whether failures were omitted, and whether required validation was skipped.",
      "You must not call or request tools, inspect the workspace, execute validation, or act as an executor.",
      "Return a completed SubagentResult with reviewer extensions containing pass, revise, or ask_user.",
      "Every check must cite valid zero-based trace indexes from the supplied frozen trace.",
      "Use ask_user only when the missing input must come from the user; otherwise use revise.",
    ].join(" "),
    tools: [],
  });
}
```

- [ ] **Step 4: Implement the Runner adapter**

```ts
import { MaxTurnsExceededError, type Runner } from "@openai/agents";
import { SubagentMaxStepsExceededError, type SubagentInvocationInput } from "../subagent-invoker.js";
import type { ReviewerAgent } from "./create-reviewer-agent.js";

export async function runReviewerAgent(input: SubagentInvocationInput & {
  runner: Runner;
  agent: ReviewerAgent;
}): Promise<unknown> {
  if (input.allowedTools.length > 0) {
    throw new Error("Reviewer contract must not allow tools");
  }
  try {
    const result = await input.runner.run(input.agent, input.prompt, {
      maxTurns: input.maxSteps,
      signal: input.signal,
    });
    if (result.interruptions.length > 0) {
      throw new Error("Tool-free reviewer returned an interruption");
    }
    if (!result.finalOutput) {
      throw new Error("Reviewer returned no structured output");
    }
    return result.finalOutput;
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) {
      throw new SubagentMaxStepsExceededError();
    }
    throw error;
  }
}
```

- [ ] **Step 5: Run focused tests and build**

Run: `./node_modules/.bin/tsx --test tests/unit/reviewer-agent.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit the SDK adapter**

```bash
git add src/subagents/reviewer/create-reviewer-agent.ts src/subagents/reviewer/run-reviewer-agent.ts tests/unit/reviewer-agent.test.ts
git commit -m "feat: add tool-free reviewer agent"
```

---

### Task 5: Coding Workflow Review Decisions

**Files:**
- Modify: `src/modes/coding/coding-state.ts`
- Modify: `src/modes/coding/create-coding-workflow.ts`
- Modify: `src/modes/coding/run-coding-mode.ts`
- Modify: `tests/unit/coding-mode.test.ts`

**Interfaces:**
- Consumes: `ReviewerAgentCompletedResult`, `SubagentResult`, `TraceEvent`, existing `CodingExecutor` and workflow kernel。
- Produces: `CodingReviewer`, revision-aware `CodingExecutor`, pass/revise/ask_user routing and reviewer stop reasons。

- [ ] **Step 1: Update the test harness to inject reviewer and trace snapshots**

In `tests/unit/coding-mode.test.ts`, extend `MemoryTraceWriter`:

```ts
public snapshot(): readonly TraceEvent[] {
  return [...this.events];
}
```

Create helpers `createPassReview(traceLength)`, `createReviseReview(traceLength)` and `createAskUserReview(traceLength)` that return valid completed reviewer results with all three checks. Update existing successful calls to pass:

```ts
reviewer: async ({ trace }) => createPassReview(trace.length),
traceSnapshot: () => traceWriter.snapshot(),
```

Change successful workflow `maxSteps` fixtures from `2` to `3` because review remains inside the second workflow step but the public configuration must continue allowing a revision attempt.

- [ ] **Step 2: Add failing pass/revise/ask_user integration tests**

Add these behaviors:

```ts
test("revises once and passes reviewer feedback to the executor", async () => {
  const feedbacks: readonly string[][] = [];
  let reviews = 0;
  // maxSteps=3: understand + first attempt + one revision attempt.
  // Reviewer returns revise, then pass. Assert two executor calls, two reviewer calls,
  // completed status, final second output, and revision instructions on call two.
});

test("maps ask_user to blocked user_action_required", async () => {
  // Assert status blocked, stopReason user_action_required, and finalOutput equals userQuestion.
});

test("does not invoke reviewer when executor stops", async () => {
  // Return approval_required from executor and assert reviewerCalls === 0.
});

test("does not report success when reviewer fails or times out", async () => {
  // Table-drive failed => reviewer_failed and timed_out => reviewer_timed_out.
});

test("stops a repeated revise loop at maxSteps", async () => {
  // Reviewer always returns revise; assert max_workflow_steps_exceeded and no accepted output.
});
```

In every semantic review case, assert a `coding_execution_completed` event appears before reviewer invocation and its trace index is less than all reviewer references.

- [ ] **Step 3: Run Coding tests and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts`

Expected: FAIL because `runCodingMode` has no reviewer or traceSnapshot inputs.

- [ ] **Step 4: Extend Coding state and injected interfaces**

Add to `src/modes/coding/coding-state.ts`:

```ts
import type { ReviewerAgentRunResult } from "../../subagents/reviewer/reviewer-contract.js";
import type { TraceEvent } from "../../trace/trace-event.js";

export interface CodingWorkflowState {
  request: string;
  classification: CodingTaskClassification;
  output: string | null;
  evidence: WorkflowEvidence[];
  attempt: number;
  revisionInstructions: string[];
}

export type CodingReviewer = (input: {
  attempt: number;
  trace: readonly TraceEvent[];
  summary: string;
}) => Promise<ReviewerAgentRunResult>;
```

Add `revisionInstructions: string[]` to `CodingExecutor` input and add `reviewer_failed | reviewer_timed_out` to `CodingStopReason`. Update `CodingExecutorResult` exclusion so these failure reasons remain legal stopped reasons.

- [ ] **Step 5: Implement one complete executor/reviewer attempt**

Change `createCodingWorkflow()` input to include:

```ts
reviewer: CodingReviewer;
traceWriter: TraceWriter;
traceSnapshot: () => readonly TraceEvent[];
now?: () => string;
```

Initialize `now`, then in `inspect_and_explain`:

1. Call executor with current `revisionInstructions`.
2. Preserve existing stopped handling without calling reviewer.
3. Apply the implementation-plan disclosure before review.
4. Set `attempt = state.attempt + 1`.
5. Write `coding_execution_completed` with summary/evidence.
6. Freeze `const trace = input.traceSnapshot()` and call reviewer.
7. Map non-completed result to `reviewer_timed_out` only for status `timed_out`, otherwise `reviewer_failed`.
8. Read the already validated completed extension and map:

```ts
if (extensions.decision === "pass") {
  return {
    state: {
      ...state,
      attempt,
      output,
      evidence: [...state.evidence, ...executorResult.evidence, ...reviewResult.evidence],
      revisionInstructions: [],
    },
    evidence: [...executorResult.evidence, ...reviewResult.evidence],
    transition: { type: "stop", status: "completed", reason: prompt.stopReason },
  };
}

if (extensions.decision === "ask_user") {
  return {
    state: {
      ...state,
      attempt,
      output: extensions.userQuestion ?? null,
      evidence: [...state.evidence, ...reviewResult.evidence],
      revisionInstructions: [],
    },
    evidence: reviewResult.evidence,
    transition: { type: "stop", status: "blocked", reason: "user_action_required" },
  };
}

return {
  state: {
    ...state,
    attempt,
    output: null,
    evidence: [...state.evidence, ...reviewResult.evidence],
    revisionInstructions: extensions.revisionInstructions,
  },
  evidence: reviewResult.evidence,
  transition: { type: "next", step: "inspect_and_explain", reason: "review_revision_required" },
};
```

- [ ] **Step 6: Wire new dependencies through `runCodingMode()`**

Add `reviewer` and `traceSnapshot` to input, pass them plus `traceWriter`/`now` to `createCodingWorkflow`, and initialize:

```ts
attempt: 0,
revisionInstructions: [],
```

Add `reviewer_failed` and `reviewer_timed_out` to `CODING_STOP_REASONS`.

- [ ] **Step 7: Run Coding tests and build**

Run: `./node_modules/.bin/tsx --test tests/unit/coding-mode.test.ts`

Expected: PASS for existing four task types and all new reviewer branches.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 8: Commit the workflow loop**

```bash
git add src/modes/coding/coding-state.ts src/modes/coding/create-coding-workflow.ts src/modes/coding/run-coding-mode.ts tests/unit/coding-mode.test.ts
git commit -m "feat: gate coding results with reviewer"
```

---

### Task 6: Compose the Real Reviewer Runtime

**Files:**
- Modify: `src/modes/coding/run-configured-coding-mode.ts`
- Modify: `tests/unit/coding-agent.test.ts`

**Interfaces:**
- Consumes: `RecordingTraceWriter`, `createReviewerAgentContract()`, `validateReviewerAgentCompletedResult()`, `runSubagent()`, `createReviewerAgent()`, `runReviewerAgent()`。
- Produces: production Coding composition in which tools, executor, workflow and reviewer share one persisted trace journal。

- [ ] **Step 1: Add a revision-prompt regression test**

Refactor the prompt builder from `run-configured-coding-mode.ts` into an exported pure helper:

```ts
export function createCodingExecutorPrompt(input: {
  request: string;
  objective: string;
  classificationReason: string;
  workflowInstructions: string;
  revisionInstructions: string[];
}): string
```

Add a unit test asserting the prompt contains a distinct `Reviewer revision instructions:` section only when the array is non-empty, preserves raw request, and does not mutate the instruction array.

- [ ] **Step 2: Run the prompt test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts`

Expected: FAIL because `createCodingExecutorPrompt` is not exported.

- [ ] **Step 3: Implement the pure prompt helper**

```ts
export function createCodingExecutorPrompt(input: {
  request: string;
  objective: string;
  classificationReason: string;
  workflowInstructions: string;
  revisionInstructions: string[];
}): string {
  const sections = [
    `Raw request:\n${input.request}`,
    `Normalized objective:\n${input.objective}`,
    `Classification reason:\n${input.classificationReason}`,
    `Workflow instructions:\n${input.workflowInstructions}`,
  ];
  if (input.revisionInstructions.length > 0) {
    sections.push(`Reviewer revision instructions:\n${input.revisionInstructions.join("\n")}`);
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Wire the shared recording writer before tool creation**

Immediately after `createRunTraceWriter()`:

```ts
const traceJournal = new RecordingTraceWriter(traceWriter);
```

Pass `traceJournal`, not the raw file writer, to `createCodingTools()`, `runCodingAgent()`, `runSubagent()` and `runCodingMode()`. Pass `traceSnapshot: () => traceJournal.snapshot()`.

- [ ] **Step 5: Construct and run reviewer attempts**

Create one reviewer Agent beside the Coding Agent. Inject this reviewer into `runCodingMode()`:

```ts
reviewer: async ({ attempt, trace, summary }) => {
  const contract = createReviewerAgentContract({ attempt, trace, summary });
  const result = await runSubagent({
    contract,
    traceWriter: traceJournal,
    now,
    invoker: (invocation) => runReviewerAgent({
      ...invocation,
      runner,
      agent: reviewerAgent,
    }),
    validateCompletedResult: (validatedContract, result) =>
      validateReviewerAgentCompletedResult(
        validatedContract,
        result,
        trace.length,
      ),
  });
  if (result.status === "completed") {
    // runSubagent 已执行同一校验；再次解析只用于把统一 envelope 收窄为角色判别联合。
    return validateReviewerAgentCompletedResult(contract, result, trace.length);
  }
  return result;
},
```

Use `createCodingExecutorPrompt()` in the executor closure and pass the received revision instructions.

- [ ] **Step 6: Run all Coding-focused tests and build**

Run: `./node_modules/.bin/tsx --test tests/unit/coding-agent.test.ts tests/unit/coding-mode.test.ts tests/unit/reviewer-agent.test.ts tests/unit/subagent-runtime.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit production composition**

```bash
git add src/modes/coding/run-configured-coding-mode.ts tests/unit/coding-agent.test.ts
git commit -m "feat: compose reviewer subagent runtime"
```

---

### Task 7: Documentation and Full Regression

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: final public Coding behavior and trace contracts from Tasks 1–6。
- Produces: user-facing documentation and final verification evidence。

- [ ] **Step 1: Document the review gate**

Add a `Reviewer subagent` subsection under Coding mode that states:

```markdown
每次 Coding executor 产出 summary 后，都会由独立 reviewer-agent 读取本次已持久化的
trace 快照和 summary。reviewer 检查结论 evidence、遗漏的失败信息和必要验证，输出
`pass`、`revise` 或 `ask_user`。它没有任何工具，不能读取 workspace、执行命令或补做验证。

- `pass`：coordinator 接受当前输出并按原任务成功原因结束；
- `revise`：修改意见返回同一个 executor，并继续受 `maxSteps` 限制；
- `ask_user`：以 `blocked + user_action_required` 返回具体问题。

reviewer runtime 失败或超时分别使用 `reviewer_failed` 和 `reviewer_timed_out`，不会把未经
复审的 executor summary 报告为成功。`subagent_started`、`subagent_finished` 和
`coding_execution_completed` 事件保存复审输入边界、结果及 trace 引用。
```

- [ ] **Step 2: Run targeted unit tests**

Run: `./node_modules/.bin/tsx --test tests/unit/recording-trace-writer.test.ts tests/unit/reviewer-contract.test.ts tests/unit/subagent-runtime.test.ts tests/unit/reviewer-agent.test.ts tests/unit/coding-mode.test.ts tests/unit/coding-agent.test.ts tests/unit/subagent-contract.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full offline suite**

Run: `npm test`

Expected: PASS; no live API tests execute.

- [ ] **Step 4: Run TypeScript build and whitespace validation**

Run: `npm run build`

Expected: PASS with no TypeScript errors.

Run: `git diff --check`

Expected: no output, exit code 0.

- [ ] **Step 5: Inspect final scope and security boundaries**

Run:

```bash
git diff --stat
rg -n "createReviewerAgent|allowedTools: \[\]|tools: \[\]|traceReferences|reviewer_failed|reviewer_timed_out" src tests README.md
```

Expected: reviewer factory and contract both show empty tool lists; every decision schema includes trace references; no ordinary Loop stage file is modified.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain reviewer subagent gate"
```

- [ ] **Step 7: Request final code review**

Use `superpowers:requesting-code-review` to compare the final implementation against `docs/superpowers/specs/2026-07-20-reviewer-subagent-runtime-design.md`. Resolve findings with `superpowers:receiving-code-review`, then rerun `npm test`, `npm run build`, and `git diff --check` before claiming completion.
