import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodingRunResult } from "../../src/modes/coding/coding-state.js";
import {
  runCodingModeWithHandoff,
} from "../../src/modes/coding/run-coding-mode-with-handoff.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

const trace: TraceEvent[] = [{
  event: "coding_run_stopped",
  timestamp: "2026-07-21T00:00:00.000Z",
  status: "completed",
  taskType: "explain_module",
  stopReason: "explanation_completed",
  completedSteps: 2,
}];

function createResult(
  status: CodingRunResult["status"],
): CodingRunResult {
  if (status === "completed") {
    return {
      status,
      taskType: "explain_module",
      stopReason: "explanation_completed",
      completedSteps: 2,
      finalOutput: "Explanation complete.",
      tracePath: "traces/completed.jsonl",
    };
  }
  if (status === "blocked") {
    return {
      status,
      taskType: "diagnose_test_failure",
      stopReason: "user_action_required",
      completedSteps: 2,
      finalOutput: "May I inspect the protected fixture?",
      tracePath: "traces/blocked.jsonl",
    };
  }
  return {
    status,
    taskType: "explain_module",
    stopReason: "runtime_error",
    completedSteps: 1,
    finalOutput: null,
    tracePath: `traces/${status}.jsonl`,
  };
}

test("generates one handoff for every returned Coding terminal status", async (t) => {
  for (const status of [
    "completed",
    "failed",
    "blocked",
    "cancelled",
  ] as const) {
    await t.test(status, async () => {
      const calls: unknown[] = [];
      const result = createResult(status);

      const returned = await runCodingModeWithHandoff({
        request: "Continue the task",
        workspaceRoot: "/workspace",
        run: async () => result,
        traceSnapshot: () => trace,
        generate: async (input) => {
          calls.push(input);
          return "/workspace/handoff.md";
        },
      });

      assert.equal(returned, result);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        request: "Continue the task",
        workspaceRoot: "/workspace",
        result,
        trace,
      });
    });
  }
});

test("does not hide a handoff generation failure", async () => {
  await assert.rejects(
    runCodingModeWithHandoff({
      request: "Continue the task",
      workspaceRoot: "/workspace",
      run: async () => createResult("completed"),
      traceSnapshot: () => trace,
      generate: async () => {
        throw new Error("handoff storage unavailable");
      },
    }),
    /handoff storage unavailable/,
  );
});

test("does not overwrite handoff when the Coding run has no terminal result", async () => {
  let generateCalls = 0;

  await assert.rejects(
    runCodingModeWithHandoff({
      request: "Continue the task",
      workspaceRoot: "/workspace",
      run: async () => {
        throw new Error("trace persistence failed");
      },
      traceSnapshot: () => trace,
      generate: async () => {
        generateCalls += 1;
        return "/workspace/handoff.md";
      },
    }),
    /trace persistence failed/,
  );
  assert.equal(generateCalls, 0);
});
