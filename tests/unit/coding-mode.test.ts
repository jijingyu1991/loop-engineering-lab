import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodingMode } from "../../src/modes/coding/run-coding-mode.js";
import type { CodingExecutor } from "../../src/modes/coding/coding-state.js";
import type { CodingTaskType } from "../../src/modes/coding/coding-task.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

const cases = [
  ["explain_module", "explanation_completed"],
  ["find_related_files", "related_files_identified"],
  ["diagnose_test_failure", "diagnosis_completed"],
  ["propose_implementation_plan", "implementation_plan_completed"],
] as const;

const requiredInstructionFragments: Record<CodingTaskType, string[]> = {
  explain_module: [
    "responsibilities",
    "entry points",
    "dependencies",
    "data flow",
    "failure boundaries",
  ],
  find_related_files: [
    "grouped paths",
    "relationship reasons",
    "explicit empty result",
  ],
  diagnose_test_failure: [
    "narrowest configured test command",
    "exit evidence",
    "root-cause hypothesis",
    "confidence",
    "forbid edits",
  ],
  propose_implementation_plan: [
    "repository conventions",
    "likely files",
    "ordered steps",
    "tests",
    "risks",
    "No files were modified.",
  ],
};

for (const [taskType, expectedStopReason] of cases) {
  test(`runs the ${taskType} workflow to its task-specific stop reason`, async () => {
    const traceWriter = new MemoryTraceWriter();
    let receivedInstructions = "";

    const result = await runCodingMode({
      request: "  Inspect the request  ",
      activeModel: "test-model",
      tracePath: "traces/test.jsonl",
      maxSteps: 2,
      traceWriter,
      classifier: async () => ({
        taskType,
        objective: "Normalized objective",
        reason: "Matched test workflow",
      }),
      executor: async (input) => {
        receivedInstructions = input.instructions;
        return {
          type: "completed",
          output: taskType === "propose_implementation_plan"
            ? "Implementation plan. No files were modified."
            : "Evidence-backed result",
          evidence: [{
            kind: "file",
            source: "src/cli.ts",
            summary: "inspected",
          }],
        };
      },
      now: () => "2026-07-15T00:00:00.000Z",
    });

    assert.equal(result.taskType, taskType);
    assert.equal(result.status, "completed");
    assert.equal(result.stopReason, expectedStopReason);
    assert.equal(
      result.finalOutput,
      taskType === "propose_implementation_plan"
        ? "Implementation plan. No files were modified."
        : "Evidence-backed result",
    );
    assert.equal(result.completedSteps, 2);
    assert.equal(result.tracePath, "traces/test.jsonl");

    for (const fragment of requiredInstructionFragments[taskType]) {
      assert.match(receivedInstructions, new RegExp(fragment.replace(".", "\\."), "i"));
    }

    const eventNames = traceWriter.events.map((event) => event.event);
    assert.equal(eventNames[0], "coding_run_started");
    assert.ok(eventNames.includes("coding_task_classified"));
    assert.ok(eventNames.includes("workflow_step_started"));
    assert.ok(eventNames.includes("workflow_step_completed"));
    assert.ok(eventNames.includes("workflow_transition_decided"));

    const firstWorkflowCompletion = traceWriter.events.find(
      (event) => event.event === "workflow_step_completed",
    );
    assert.ok(firstWorkflowCompletion);
    assert.deepEqual(firstWorkflowCompletion.evidence, [
      {
        kind: "classification_objective",
        source: taskType,
        summary: "Normalized objective",
      },
      {
        kind: "classification_reason",
        source: taskType,
        summary: "Matched test workflow",
      },
    ]);

    const terminalEvent = traceWriter.events.at(-1);
    assert.ok(terminalEvent);
    assert.equal(terminalEvent.event, "coding_run_stopped");
    if (terminalEvent.event === "coding_run_stopped") {
      assert.equal(terminalEvent.status, "completed");
      assert.equal(terminalEvent.taskType, taskType);
      assert.equal(terminalEvent.stopReason, expectedStopReason);
      assert.equal(terminalEvent.completedSteps, 2);
    }
  });
}

test("returns classification_failed and a terminal trace when classification throws", async () => {
  const traceWriter = new MemoryTraceWriter();

  const result = await runCodingMode({
    request: "Explain the module",
    activeModel: "test-model",
    tracePath: "traces/classification-failed.jsonl",
    maxSteps: 2,
    traceWriter,
    classifier: async () => { throw new Error("classifier unavailable"); },
    executor: async () => { throw new Error("executor must not run"); },
  });

  assert.deepEqual(result, {
    status: "failed",
    taskType: null,
    stopReason: "classification_failed",
    completedSteps: 0,
    finalOutput: null,
    tracePath: "traces/classification-failed.jsonl",
  });
  assert.deepEqual(traceWriter.events.map((event) => event.event), [
    "coding_run_started",
    "coding_run_stopped",
  ]);
  const terminalEvent = traceWriter.events.at(-1);
  assert.ok(terminalEvent);
  assert.equal(terminalEvent.event, "coding_run_stopped");
  if (terminalEvent.event === "coding_run_stopped") {
    assert.equal(terminalEvent.status, "failed");
    assert.equal(terminalEvent.taskType, null);
    assert.equal(terminalEvent.stopReason, "classification_failed");
  }
});

test("forwards a blocked executor result to the terminal trace", async () => {
  const traceWriter = new MemoryTraceWriter();

  const result = await runCodingMode({
    request: "Diagnose the failure",
    activeModel: "test-model",
    tracePath: "traces/blocked.jsonl",
    maxSteps: 2,
    traceWriter,
    classifier: async () => ({
      taskType: "diagnose_test_failure",
      objective: "Find the cause",
      reason: "A test failed",
    }),
    executor: async () => ({
      type: "stopped",
      status: "blocked",
      reason: "approval_required",
    }),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.stopReason, "approval_required");
  assert.equal(result.finalOutput, null);
  const terminalEvent = traceWriter.events.at(-1);
  assert.ok(terminalEvent);
  assert.equal(terminalEvent.event, "coding_run_stopped");
  if (terminalEvent.event === "coding_run_stopped") {
    assert.equal(terminalEvent.status, "blocked");
    assert.equal(terminalEvent.stopReason, "approval_required");
  }
});

test("rejects when the trace writer fails", async () => {
  await assert.rejects(
    runCodingMode({
      request: "Explain the module",
      activeModel: "test-model",
      tracePath: "traces/unavailable.jsonl",
      maxSteps: 2,
      traceWriter: {
        write: async () => { throw new Error("trace unavailable"); },
      },
      classifier: async () => ({
        taskType: "explain_module",
        objective: "Explain it",
        reason: "Explanation requested",
      }),
      executor: async () => ({
        type: "completed",
        output: "Result",
        evidence: [],
      }),
    }),
    /trace unavailable/,
  );
});

test("rejects an empty request before writing the start trace", async () => {
  const traceWriter = new MemoryTraceWriter();

  await assert.rejects(
    runCodingMode({
      request: "   ",
      activeModel: "test-model",
      tracePath: "traces/empty.jsonl",
      maxSteps: 2,
      traceWriter,
      classifier: async () => {
        throw new Error("classifier must not run");
      },
      executor: async () => {
        throw new Error("executor must not run");
      },
    }),
    /must not be empty/i,
  );
  assert.deepEqual(traceWriter.events, []);
});

test("rejects an invalid maxSteps before writing the start trace", async () => {
  const traceWriter = new MemoryTraceWriter();

  await assert.rejects(
    runCodingMode({
      request: "Explain the module",
      activeModel: "test-model",
      tracePath: "traces/invalid-max-steps.jsonl",
      maxSteps: 0,
      traceWriter,
      classifier: async () => {
        throw new Error("classifier must not run");
      },
      executor: async () => {
        throw new Error("executor must not run");
      },
    }),
    /maxSteps must be a positive integer/,
  );
  assert.deepEqual(traceWriter.events, []);
});

test("forces failed status when an unknown workflow reason maps to runtime_error", async () => {
  const traceWriter = new MemoryTraceWriter();
  // TypeScript 会阻止 adapter 返回未知 reason；这里故意模拟一个绕过静态合同的运行时
  // 违约值，验证 coordinator 的最后一道防线不会产生 completed + runtime_error。
  const executor = (async () => ({
    type: "stopped",
    status: "cancelled",
    reason: "future_unknown_reason",
  })) as unknown as CodingExecutor;

  const result = await runCodingMode({
    request: "Explain the module",
    activeModel: "test-model",
    tracePath: "traces/unknown-reason.jsonl",
    maxSteps: 2,
    traceWriter,
    classifier: async () => ({
      taskType: "explain_module",
      objective: "Explain it",
      reason: "Explanation requested",
    }),
    executor,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "runtime_error");
  const terminalEvent = traceWriter.events.at(-1);
  assert.ok(terminalEvent);
  assert.equal(terminalEvent.event, "coding_run_stopped");
  if (terminalEvent.event === "coding_run_stopped") {
    assert.equal(terminalEvent.status, "failed");
    assert.equal(terminalEvent.stopReason, "runtime_error");
  }
});
