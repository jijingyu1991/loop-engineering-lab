import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorkflow } from "../../src/runtime/run-workflow.js";
import type { WorkflowDefinition } from "../../src/runtime/workflow-types.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

interface State {
  visits: string[];
}

test("runs named steps and records the terminal transition", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "inspect",
    steps: new Map([
      ["inspect", {
        name: "inspect",
        run: async (state) => ({
          state: { visits: [...state.visits, "inspect"] },
          evidence: [{ kind: "file", source: "src/a.ts", summary: "read" }],
          transition: { type: "next", step: "summarize", reason: "context_ready" },
        }),
      }],
      ["summarize", {
        name: "summarize",
        run: async (state) => ({
          state: { visits: [...state.visits, "summarize"] },
          evidence: [],
          transition: { type: "stop", status: "completed", reason: "done" },
        }),
      }],
    ]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 3,
    traceWriter,
    now: () => "2026-07-15T00:00:00.000Z",
  });

  assert.deepEqual(result.state.visits, ["inspect", "summarize"]);
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "done");
  assert.equal(result.completedSteps, 2);
  assert.deepEqual(traceWriter.events.map((event) => event.event), [
    "workflow_step_started",
    "workflow_step_completed",
    "workflow_transition_decided",
    "workflow_step_started",
    "workflow_step_completed",
    "workflow_transition_decided",
  ]);
});

test("fails an unknown transition target", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "inspect",
    steps: new Map([["inspect", {
      name: "inspect",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "next", step: "missing", reason: "bad_route" },
      }),
    }]]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 3,
    traceWriter,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "workflow_step_failed");
  assert.equal(traceWriter.events.at(-1)?.event, "workflow_step_failed");
});

test("stops at the workflow step limit", async () => {
  const traceWriter = new MemoryTraceWriter();
  const definition: WorkflowDefinition<State> = {
    initialStep: "again",
    steps: new Map([["again", {
      name: "again",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "next", step: "again", reason: "repeat" },
      }),
    }]]),
  };

  const result = await runWorkflow({
    definition,
    initialState: { visits: [] },
    maxSteps: 1,
    traceWriter,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "max_workflow_steps_exceeded");
});

test("propagates trace write failures", async () => {
  const definition: WorkflowDefinition<State> = {
    initialStep: "done",
    steps: new Map([["done", {
      name: "done",
      run: async (state) => ({
        state,
        evidence: [],
        transition: { type: "stop", status: "completed", reason: "done" },
      }),
    }]]),
  };

  await assert.rejects(
    runWorkflow({
      definition,
      initialState: { visits: [] },
      maxSteps: 1,
      traceWriter: { write: async () => { throw new Error("trace unavailable"); } },
    }),
    /trace unavailable/,
  );
});
