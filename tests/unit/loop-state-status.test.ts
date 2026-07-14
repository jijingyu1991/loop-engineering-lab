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
