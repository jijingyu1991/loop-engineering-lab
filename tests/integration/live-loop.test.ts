import assert from "node:assert/strict";
import { test } from "node:test";

import { runConfiguredLoop } from "../../src/cli.js";

/**
 * 真实测试必须显式启用，因为它会消耗付费 API token，并且需要有效凭据。
 * 单元测试会在不联网的情况下覆盖全部编排逻辑；这个检查点用于证明当前
 * 选中的 provider 能够端到端工作。
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
