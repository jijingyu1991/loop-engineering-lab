import assert from "node:assert/strict";
import { test } from "node:test";

import "../../src/domain/step-decision.js";
import type { StepOutcome } from "../../src/domain/step-decision.js";
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
