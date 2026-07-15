import assert from "node:assert/strict";
import { test } from "node:test";
import { MaxTurnsExceededError } from "@openai/agents";

import { LOOP_STAGE_ORDER } from "../../src/domain/loop-step.js";
import { runLoop } from "../../src/loop/loop-runner.js";
import type {
  StageTraceEvent,
  TraceEvent,
} from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

test("runs seven stages in order for three iterations", async () => {
  const traceWriter = new MemoryTraceWriter();
  let actionCalls = 0;

  const state = await runLoop({
    task: "Improve this answer",
    activeModel: "gpt",
    maxSteps: 3,
    maxTurns: 5,
    traceWriter,
    act: async ({ observation }) => {
      actionCalls += 1;
      return {
        data: {
          output: `${observation.task} result ${actionCalls}`,
          outcome: actionCalls >= 3 ? "succeeded" : "continue",
          toolErrors: [],
        },
        decision: {
          nextStep: "verify",
          reason: "action_completed",
        },
      };
    },
  });

  const completedStages = traceWriter.events
    .filter(
      (event): event is StageTraceEvent =>
        event.event === "stage_completed",
    )
    .map((event) => event.stage);

  assert.equal(actionCalls, 3);
  assert.equal(state.steps.length, 3);
  assert.deepEqual(completedStages, [
    ...LOOP_STAGE_ORDER,
    ...LOOP_STAGE_ORDER,
    ...LOOP_STAGE_ORDER,
  ]);
  assert.equal(state.status, "completed");
  assert.equal(state.stopReason, "plan_condition_met");
});

test("classifies Agents SDK maxTurns failure and still records stop", async () => {
  const traceWriter = new MemoryTraceWriter();

  const state = await runLoop({
    task: "Use tools until complete",
    activeModel: "deepseek",
    maxSteps: 3,
    maxTurns: 1,
    traceWriter,
    act: async () => {
      throw new MaxTurnsExceededError("Maximum turns exceeded");
    },
  });

  assert.equal(state.status, "failed");
  assert.equal(state.stopReason, "max_turns_exceeded");
  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0]?.verify.status, "skipped");
  assert.equal(state.steps[0]?.reflect.status, "skipped");
  assert.equal(state.steps[0]?.stop.status, "completed");
});

test("follows an action decision that jumps directly to stop", async () => {
  const traceWriter = new MemoryTraceWriter();

  const state = await runLoop({
    task: "Stop after the first action",
    activeModel: "gpt",
    maxSteps: 1,
    maxTurns: 5,
    traceWriter,
    act: async () => ({
      data: {
        output: "Enough evidence to stop",
        outcome: "succeeded",
        toolErrors: [],
      },
      decision: {
        nextStep: "stop",
        reason: "action_requested_stop",
      },
    }),
  });

  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0]?.act.status, "completed");
  assert.equal(state.steps[0]?.verify.status, "skipped");
  assert.equal(state.steps[0]?.reflect.status, "skipped");
  assert.equal(state.steps[0]?.stop.status, "completed");
});
