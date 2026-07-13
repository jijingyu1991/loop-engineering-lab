# StepDecision Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded stage sequence in `runLoopStep` with decisions returned directly by each non-terminal stage while preserving the current default order and observable behavior.

**Architecture:** Add provider-neutral `StepDecision` and `StepOutcome<T>` domain contracts. Each stage returns its business data plus a default next-stage decision; `runLoopStep` becomes a small state-machine loop that persists only the business data, follows the returned decision, routes failures to `stop`, and rejects repeated-stage cycles.

**Tech Stack:** TypeScript 7, ESM, Node.js 22+, `node:test`, `node:assert/strict`, `tsx`.

## Global Constraints

- Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons.
- Keep domain code provider-neutral and isolate SDK concerns in adapters.
- Add detailed Chinese comments around design intent, data flow, failure handling, and boundary conditions.
- Preserve `LoopStep`, `LoopState`, trace event payloads, stop semantics, and the public `runLoop` result.
- Preserve the default route `observe -> orient -> plan -> act -> verify -> reflect -> stop`.
- Do not implement Agent-selected routing, retries, rollback, or cross-`LoopStep` jumps.
- Do not run the paid live integration test unless explicitly authorized with credentials.

## File Map

- Create `src/domain/step-decision.ts`: provider-neutral transition contracts.
- Create `src/loop/resolve-next-step.ts`: cycle-safe consumption of a stage decision.
- Create `tests/unit/step-decision.test.ts`: decision contracts, default decisions, and cycle guard.
- Modify `src/loop/stages/{observe,orient,plan,act,verify,reflect}.ts`: return `StepOutcome<T>` directly.
- Modify `src/loop/run-loop-step.ts`: execute a decision-driven state-machine loop.
- Modify `src/cli.ts`: pass through the `StepOutcome<ActData>` returned by `runAct`.
- Modify `tests/unit/loop-step.test.ts`: read stage business values from `outcome.data`.
- Modify `tests/unit/loop-runner.test.ts`: make injected `act` executors return an action decision.
- Modify `README.md`: document decision-produced routing and update the reading guide.

---

### Task 1: Add the domain transition contract

**Files:**
- Create: `src/domain/step-decision.ts`
- Create: `tests/unit/step-decision.test.ts`

**Interfaces:**
- Consumes: `LoopStage` from `src/domain/loop-step.ts`.
- Produces: `StepType`, `StepDecision`, and `StepOutcome<T>`.

- [ ] **Step 1: Write the failing contract test**

Create `tests/unit/step-decision.test.ts` with a runtime example that also forces TypeScript to resolve the new module:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  StepOutcome,
} from "../../src/domain/step-decision.js";
import type { PlanData } from "../../src/domain/loop-step.js";

test("represents stage data and its next-step decision", () => {
  const outcome: StepOutcome<PlanData> = {
    data: {
      nextAction: "Execute the plan",
      stopCondition: { description: "Finish the task" },
    },
    decision: {
      nextStep: "act",
      reason: "plan_completed",
    },
  };

  assert.equal(outcome.decision.nextStep, "act");
  assert.equal(outcome.decision.reason, "plan_completed");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts
```

Expected: FAIL because `src/domain/step-decision.ts` does not exist.

- [ ] **Step 3: Add the minimal domain types**

Create `src/domain/step-decision.ts`:

```ts
import type { LoopStage } from "./loop-step.js";

/** 当前可被阶段决策选择的执行节点；stop 是唯一终态节点。 */
export type StepType = LoopStage;

/**
 * 非终态阶段显式声明下一执行节点及机器可读原因。reason 暂时保持 string，
 * 等协议稳定后再收窄为字面量联合，避免过早固化不完整的原因集合。
 */
export interface StepDecision {
  nextStep: StepType;
  reason: string;
}

/** 阶段业务数据和控制流决策同时产生，但只有 data 会进入持久化 LoopStep。 */
export interface StepOutcome<T> {
  data: T;
  decision: StepDecision;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts
```

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Commit the contract**

```bash
git add src/domain/step-decision.ts tests/unit/step-decision.test.ts
git commit -m "feat: add step decision contract"
```

---

### Task 2: Return default decisions and route the coordinator

**Files:**
- Modify: `src/loop/stages/observe.ts`
- Modify: `src/loop/stages/orient.ts`
- Modify: `src/loop/stages/plan.ts`
- Modify: `src/loop/stages/act.ts`
- Modify: `src/loop/stages/verify.ts`
- Modify: `src/loop/stages/reflect.ts`
- Create: `src/loop/resolve-next-step.ts`
- Modify: `src/loop/run-loop-step.ts`
- Modify: `src/cli.ts`
- Modify: `tests/unit/step-decision.test.ts`
- Modify: `tests/unit/loop-step.test.ts`
- Modify: `tests/unit/loop-runner.test.ts`

**Interfaces:**
- Consumes: `StepOutcome<T>` from Task 1 and existing stage input/data types.
- Produces: every non-terminal `runX` stage function returning `StepOutcome<XData>` or `Promise<StepOutcome<XData>>`; `resolveNextStep(decision, visitedSteps): StepType`; `ActExecutor` returning `Promise<StepOutcome<ActData>>`; decision-driven `runLoopStep` with unchanged return type.

- [ ] **Step 1: Add failing assertions for every default decision**

Extend `tests/unit/step-decision.test.ts`. Use a minimal fake Runner for `runAct` so no API call occurs:

```ts
import type { Agent, Runner } from "@openai/agents";
import { runAct } from "../../src/loop/stages/act.js";
import { runObserve } from "../../src/loop/stages/observe.js";
import { runOrient } from "../../src/loop/stages/orient.js";
import { runPlan } from "../../src/loop/stages/plan.js";
import { runReflect } from "../../src/loop/stages/reflect.js";
import { runVerify } from "../../src/loop/stages/verify.js";

test("stages return the current default route", async () => {
  const observation = runObserve({ task: "Improve this answer" });
  assert.deepEqual(observation.decision, {
    nextStep: "orient",
    reason: "observation_completed",
  });

  const orientation = await runOrient(observation.data);
  assert.deepEqual(orientation.decision, {
    nextStep: "plan",
    reason: "orientation_completed",
  });

  const plan = await runPlan({ stepIndex: 1, objective: orientation.data.objective });
  assert.deepEqual(plan.decision, {
    nextStep: "act",
    reason: "plan_completed",
  });

  const runner = {
    run: async () => ({ finalOutput: "Agent result" }),
  } as unknown as Runner;
  const action = await runAct({
    runner,
    agent: {} as Agent,
    observation: observation.data,
    plan: plan.data,
    maxTurns: 5,
  });
  assert.deepEqual(action.decision, {
    nextStep: "verify",
    reason: "action_completed",
  });

  const verification = await runVerify({
    stepIndex: 1,
    plan: plan.data,
    actionOutput: action.data.output,
  });
  assert.deepEqual(verification.decision, {
    nextStep: "reflect",
    reason: "verification_completed",
  });

  const reflection = await runReflect({
    actionOutput: action.data.output,
    verification: verification.data,
  });
  assert.deepEqual(reflection.decision, {
    nextStep: "stop",
    reason: "reflection_completed",
  });
});
```

Update `tests/unit/loop-step.test.ts` to read `plan.data` and `verification.data`, for example:

```ts
const plan = await runPlan({ stepIndex: 1, objective: "Improve this answer" });
assert.match(plan.data.stopCondition.description, /three iterations/i);

const beforeBoundary = await runVerify({
  stepIndex: 2,
  plan: plan.data,
  actionOutput: "Second result",
});
assert.equal(beforeBoundary.data.passed, false);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts tests/unit/loop-step.test.ts
```

Expected: FAIL because existing stage results do not have `data` and `decision` wrappers.

- [ ] **Step 3: Wrap each stage result with its default decision**

Import `StepOutcome` as a type in each stage. Preserve existing business-data construction, then return the wrapper. The `runPlan` implementation must follow this exact shape:

```ts
export async function runPlan(input: PlanInput): Promise<StepOutcome<PlanData>> {
  return {
    data: {
      nextAction: `Execute iteration ${input.stepIndex} for: ${input.objective}`,
      stopCondition: {
        description: "Complete three iterations of the task.",
      },
    },
    decision: {
      nextStep: "act",
      reason: "plan_completed",
    },
  };
}
```

Use the same structure for the other stages with these exact decision values:

```ts
// runObserve
decision: { nextStep: "orient", reason: "observation_completed" }

// runOrient
decision: { nextStep: "plan", reason: "orientation_completed" }

// runAct
decision: { nextStep: "verify", reason: "action_completed" }

// runVerify
decision: { nextStep: "reflect", reason: "verification_completed" }

// runReflect
decision: { nextStep: "stop", reason: "reflection_completed" }
```

For `runAct`, perform the empty-output validation first, then return:

```ts
return {
  data: { output: result.finalOutput.trim() },
  decision: { nextStep: "verify", reason: "action_completed" },
};
```

- [ ] **Step 4: Run the focused stage tests and verify GREEN**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts tests/unit/loop-step.test.ts
```

Expected: PASS for all tests in both files. This is an intermediate focused checkpoint; continue directly to coordinator integration before committing because the full suite still consumes the old contract.

#### Coordinator integration

- [ ] **Step 5: Write the failing cycle-guard test and migrate injected action fixtures**

Add to `tests/unit/step-decision.test.ts`:

```ts
import { resolveNextStep } from "../../src/loop/resolve-next-step.js";

test("rejects a decision that revisits a stage", () => {
  assert.throws(
    () =>
      resolveNextStep(
        { nextStep: "observe", reason: "retry_without_policy" },
        new Set(["observe"]),
      ),
    /already executed.*observe/i,
  );
});
```

In every `act` callback in `tests/unit/loop-runner.test.ts`, return an outcome:

```ts
return {
  data: { output: `${observation.task} result ${actionCalls}` },
  decision: { nextStep: "verify", reason: "action_completed" },
};
```

Keep the failure callback throwing `MaxTurnsExceededError`; thrown executors do not produce decisions.

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts tests/unit/loop-runner.test.ts
```

Expected: FAIL because `resolve-next-step.ts` does not exist and `runLoopStep` still treats stage outcomes as business data.

- [ ] **Step 7: Add the cycle-safe decision resolver**

Create `src/loop/resolve-next-step.ts`:

```ts
import type {
  StepDecision,
  StepType,
} from "../domain/step-decision.js";

/**
 * 当前 LoopStep 不定义重试语义，因此任何回到已执行阶段的决策都属于协议错误。
 * 在真正执行跳转前拒绝它，避免错误决策形成无法受 maxSteps 约束的内部死循环。
 */
export function resolveNextStep(
  decision: StepDecision,
  visitedSteps: ReadonlySet<StepType>,
): StepType {
  if (visitedSteps.has(decision.nextStep)) {
    throw new Error(`Step already executed in this LoopStep: ${decision.nextStep}`);
  }

  return decision.nextStep;
}
```

- [ ] **Step 8: Refactor the coordinator into a decision loop**

Change `ActExecutor` to:

```ts
export type ActExecutor = (
  input: ActExecutorInput,
) => Promise<StepOutcome<ActData>>;
```

Keep the existing `executeStage` lifecycle logic. Add a wrapper that separates the transient decision from the persisted data:

```ts
interface DecisionStageExecution<T> extends StageExecution<T> {
  decision: StepDecision | null;
}

async function executeDecisionStage<T>(input: {
  stepIndex: number;
  stageName: LoopStage;
  stage: StageResult<T>;
  traceWriter: TraceWriter;
  now: () => string;
  execute: () => Promise<StepOutcome<T>> | StepOutcome<T>;
}): Promise<DecisionStageExecution<T>> {
  let decision: StepDecision | null = null;
  const execution = await executeStage({
    ...input,
    execute: async () => {
      const outcome = await input.execute();
      decision = outcome.decision;
      return outcome.data;
    },
  });

  return { ...execution, decision };
}
```

Replace the fixed chain in `runLoopStep` with this decision loop. Each switch branch calls `executeDecisionStage`, stores the returned business data for dependent stages, and assigns its `DecisionStageExecution`:

```ts
const visitedSteps = new Set<StepType>();
let currentStep: StepType = "observe";
let observation: ObserveData | null = null;
let orientation: OrientData | null = null;
let plan: PlanData | null = null;
let action: ActData | null = null;
let verification: VerifyData | null = null;
let failureReason: StopInput["failureReason"];

while (currentStep !== "stop") {
  visitedSteps.add(currentStep);
  let execution: DecisionStageExecution<unknown> | null = null;

  switch (currentStep) {
    case "observe": {
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "observe",
        stage: step.observe,
        traceWriter: input.traceWriter,
        now,
        execute: () => runObserve({ task: input.task, previousStep: input.previousStep }),
      });
      observation = result.data;
      execution = result;
      break;
    }
    case "orient": {
      if (!observation) {
        throw new Error("orient requires a completed observe stage");
      }
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "orient",
        stage: step.orient,
        traceWriter: input.traceWriter,
        now,
        execute: () => runOrient(observation),
      });
      orientation = result.data;
      execution = result;
      break;
    }
    case "plan": {
      if (!orientation) {
        throw new Error("plan requires a completed orient stage");
      }
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "plan",
        stage: step.plan,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runPlan({ stepIndex: step.index, objective: orientation.objective }),
      });
      plan = result.data;
      execution = result;
      break;
    }
    case "act": {
      if (!observation || !plan) {
        throw new Error("act requires completed observe and plan stages");
      }
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "act",
        stage: step.act,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          input.act({ observation, plan, maxTurns: input.maxTurns }),
      });
      action = result.data;
      execution = result;
      break;
    }
    case "verify": {
      if (!plan || !action) {
        throw new Error("verify requires completed plan and act stages");
      }
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "verify",
        stage: step.verify,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runVerify({
            stepIndex: step.index,
            plan,
            actionOutput: action.output,
          }),
      });
      verification = result.data;
      execution = result;
      break;
    }
    case "reflect": {
      if (!action || !verification) {
        throw new Error("reflect requires completed act and verify stages");
      }
      const result = await executeDecisionStage({
        stepIndex: step.index,
        stageName: "reflect",
        stage: step.reflect,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runReflect({ actionOutput: action.output, verification }),
      });
      execution = result;
      break;
    }
  }

  if (!execution) {
    throw new Error(`No executor registered for stage: ${currentStep}`);
  }

  if (!execution.ok || !execution.decision) {
    failureReason =
      execution.rawError instanceof MaxTurnsExceededError
        ? "max_turns_exceeded"
        : "step_error";
    currentStep = "stop";
    continue;
  }

  currentStep = resolveNextStep(execution.decision, visitedSteps);
}
```

After leaving the loop, skip every non-stop stage whose status is still `pending`, using `LOOP_STAGE_ORDER` and the existing `skipStage`. Then run the existing `stop` stage with `verification?.passed ?? false` and `failureReason`. Preserve the current final `LoopStep.status`, `completedAt`, and `{ step, decision }` return behavior.

- [ ] **Step 9: Update the CLI action adapter**

The existing CLI callback can continue returning `runAct` directly because `runAct` now returns `StepOutcome<ActData>`:

```ts
act: ({ observation, plan, maxTurns }) =>
  runAct({ runner, agent, observation, plan, maxTurns }),
```

No transformation should strip `decision` from this value.

- [ ] **Step 10: Run the coordinator tests and verify GREEN**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/step-decision.test.ts tests/unit/loop-runner.test.ts
```

Expected: PASS. The existing trace assertion must still show three copies of `LOOP_STAGE_ORDER`; the max-turns test must still show failed `act`, skipped `verify`/`reflect`, and completed `stop`.

- [ ] **Step 11: Run all offline unit tests**

Run:

```bash
npm test
```

Expected: all unit tests PASS with 0 failures.

- [ ] **Step 12: Commit the routed stages and coordinator**

```bash
git add src/loop/stages src/loop/resolve-next-step.ts src/loop/run-loop-step.ts src/cli.ts tests/unit/step-decision.test.ts tests/unit/loop-step.test.ts tests/unit/loop-runner.test.ts
git commit -m "feat: route loop stages by decision"
```

---

### Task 3: Document and verify the completed behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the completed routed stage behavior from Tasks 1–2.
- Produces: accurate learning-project documentation and fresh verification evidence.

- [ ] **Step 1: Update the README description**

Replace “每一轮 `LoopStep` 固定执行七个阶段” with language that distinguishes current defaults from orchestration:

````md
每一轮 `LoopStep` 当前由各阶段返回的 `StepDecision` 形成以下默认路径：

```text
observe → orient → plan → act → verify → reflect → stop
```

阶段会同时返回业务数据和下一阶段决策，例如 plan 返回
`{ nextStep: "act", reason: "plan_completed" }`。`runLoopStep` 只负责执行决策，
因此未来可以在阶段内部升级为条件跳转，而不需要重写协调器。
````

Update the reading-guide entry for `src/loop/run-loop-step.ts` to say it consumes decisions and handles failure skipping. Keep all configuration and API-cost documentation unchanged.

- [ ] **Step 2: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Run fresh full unit verification**

Run:

```bash
npm test
```

Expected: exit code 0 and 0 failed tests.

- [ ] **Step 4: Run fresh TypeScript build verification**

Run:

```bash
npm run build
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 5: Run the safe integration command**

Run:

```bash
npm run test:integration
```

Expected: exit code 0; the paid live-loop case is reported as skipped because `RUN_LIVE_LOOP` is not set.

- [ ] **Step 6: Inspect final scope**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only the planned TypeScript, tests, and README changes are present; no `dist/`, trace, `.env`, or unrelated files are included.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain decision-driven stage routing"
```
