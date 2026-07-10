import assert from "node:assert/strict";
import { test } from "node:test";

import { createLoopState } from "../../src/loop/create-loop-state.js";
import { runPlan } from "../../src/loop/stages/plan.js";
import { runVerify } from "../../src/loop/stages/verify.js";

const now = "2026-07-10T09:00:00.000Z";

test("creates an empty running state", () => {
  const state = createLoopState("Improve this answer", "gpt", now);

  assert.equal(state.status, "running");
  assert.equal(state.task, "Improve this answer");
  assert.equal(state.activeModel, "gpt");
  assert.deepEqual(state.steps, []);
  assert.equal(state.stopReason, null);
});

test("skeleton plan owns the three-iteration business stop condition", async () => {
  const plan = await runPlan({
    stepIndex: 1,
    objective: "Improve this answer",
  });

  assert.match(plan.stopCondition.description, /three iterations/i);
  assert.match(plan.nextAction, /iteration 1/i);
});

test("skeleton verification passes only on iteration three", async () => {
  const plan = await runPlan({
    stepIndex: 1,
    objective: "Improve this answer",
  });

  const beforeBoundary = await runVerify({
    stepIndex: 2,
    plan,
    actionOutput: "Second result",
  });
  const atBoundary = await runVerify({
    stepIndex: 3,
    plan,
    actionOutput: "Third result",
  });

  assert.equal(beforeBoundary.passed, false);
  assert.equal(atBoundary.passed, true);
  assert.match(atBoundary.evidence, /iteration 3/i);
});
