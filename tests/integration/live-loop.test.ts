import assert from "node:assert/strict";
import { test } from "node:test";

import { runConfiguredLoop } from "../../src/cli.js";

/**
 * Live tests are opt-in because they consume paid API tokens and require a
 * credential. Unit tests still exercise all orchestration without networking;
 * this checkpoint proves the selected provider works end to end.
 */
test(
  "runs a live three-step loop through the configured model",
  { skip: process.env.RUN_LIVE_LOOP !== "1" },
  async () => {
    const state = await runConfiguredLoop(
      "Improve this concise task description over three iterations.",
    );

    assert.equal(state.steps.length, 3);
    assert.equal(state.status, "completed");
    assert.equal(state.stopReason, "plan_condition_met");
    assert.ok(
      state.steps.every(
        (step) =>
          step.act.source === "agent" &&
          step.act.status === "completed" &&
          Boolean(step.act.data?.output),
      ),
    );
  },
);
