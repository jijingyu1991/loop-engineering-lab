import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runner } from "@openai/agents";

import type { ActorAgent } from "../../src/agents/create-agent.js";
import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import "../../src/domain/step-decision.js";
import type { StepOutcome } from "../../src/domain/step-decision.js";
import type { PlanData } from "../../src/domain/loop-step.js";
import { runAct } from "../../src/loop/stages/act.js";
import { runObserve } from "../../src/loop/stages/observe.js";
import { runOrient } from "../../src/loop/stages/orient.js";
import { runPlan } from "../../src/loop/stages/plan.js";
import { runReflect } from "../../src/loop/stages/reflect.js";
import { runVerify } from "../../src/loop/stages/verify.js";
import { resolveNextStep } from "../../src/loop/resolve-next-step.js";

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

  const plan = await runPlan({
    stepIndex: 1,
    objective: orientation.data.objective,
  });
  assert.deepEqual(plan.decision, {
    nextStep: "act",
    reason: "plan_completed",
  });

  const runner = {
    run: async () => ({
      finalOutput: { output: "Agent result", outcome: "continue" },
      interruptions: [],
    }),
  } as unknown as Runner;
  const action = await runAct({
    runner,
    agent: {} as ActorAgent,
    observation: observation.data,
    plan: plan.data,
    maxTurns: 5,
    outcomeRecorder: createToolOutcomeRecorder(),
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
