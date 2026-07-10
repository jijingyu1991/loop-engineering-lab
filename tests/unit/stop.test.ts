import assert from "node:assert/strict";
import { test } from "node:test";

import { decideStop } from "../../src/loop/stages/stop.js";

test("plan completion wins at the maxSteps boundary", () => {
  const decision = decideStop({
    stepIndex: 3,
    maxSteps: 3,
    verificationPassed: true,
  });

  assert.deepEqual(decision, {
    shouldStop: true,
    status: "completed",
    reason: "plan_condition_met",
  });
});

test("maxSteps fails when the plan condition is unmet", () => {
  const decision = decideStop({
    stepIndex: 3,
    maxSteps: 3,
    verificationPassed: false,
  });

  assert.deepEqual(decision, {
    shouldStop: true,
    status: "failed",
    reason: "max_steps_exceeded",
  });
});

test("maxTurns failure has priority over verification", () => {
  const decision = decideStop({
    stepIndex: 3,
    maxSteps: 3,
    verificationPassed: true,
    failureReason: "max_turns_exceeded",
  });

  assert.deepEqual(decision, {
    shouldStop: true,
    status: "failed",
    reason: "max_turns_exceeded",
  });
});

test("continues before limits when verification has not passed", () => {
  const decision = decideStop({
    stepIndex: 1,
    maxSteps: 3,
    verificationPassed: false,
  });

  assert.deepEqual(decision, {
    shouldStop: false,
    status: "running",
    reason: null,
  });
});
