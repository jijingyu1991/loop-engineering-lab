import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodingMode } from "../../src/modes/coding/run-coding-mode.js";
import type { CodingExecutor } from "../../src/modes/coding/coding-state.js";
import type { CodingTaskType } from "../../src/modes/coding/coding-task.js";
import type {
  ReviewerAgentCompletedResult,
} from "../../src/subagents/reviewer/reviewer-contract.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  public snapshot(): readonly TraceEvent[] {
    return [...this.events];
  }
}

function createReviewResult(input: {
  traceLength: number;
  decision: "pass" | "revise" | "ask_user";
}): ReviewerAgentCompletedResult {
  const traceReference = input.traceLength - 1;
  const checkStatuses = input.decision === "pass"
    ? ["passed", "passed", "passed"] as const
    : input.decision === "revise"
    ? ["failed", "passed", "passed"] as const
    : ["needs_user", "passed", "passed"] as const;

  return {
    contractId: "review-coding-attempt",
    role: "reviewer-agent",
    status: "completed",
    summary: `Reviewer decision: ${input.decision}`,
    evidence: [
      {
        kind: "review_decision",
        source: "review-coding-attempt",
        summary: input.decision,
      },
      {
        kind: "trace_reference",
        source: "coding-trace",
        summary: `Referenced trace index ${traceReference}.`,
      },
    ],
    errors: [],
    extensions: {
      decision: input.decision,
      checks: [
        {
          criterion: "conclusion_evidence",
          status: checkStatuses[0],
          summary: "Conclusion is trace-backed.",
          traceReferences: [traceReference],
        },
        {
          criterion: "failure_disclosure",
          status: checkStatuses[1],
          summary: "Failure disclosure was reviewed.",
          traceReferences: [traceReference],
        },
        {
          criterion: "required_validation",
          status: checkStatuses[2],
          summary: "Required validation was reviewed.",
          traceReferences: [traceReference],
        },
      ],
      revisionInstructions: input.decision === "revise"
        ? ["Add the missing trace-backed explanation."]
        : [],
      ...(input.decision === "ask_user"
        ? { userQuestion: "May I inspect the protected fixture?" }
        : {}),
    },
  };
}

function createPassReview(traceLength: number): ReviewerAgentCompletedResult {
  return createReviewResult({ traceLength, decision: "pass" });
}

function createReviseReview(traceLength: number): ReviewerAgentCompletedResult {
  return createReviewResult({ traceLength, decision: "revise" });
}

function createAskUserReview(traceLength: number): ReviewerAgentCompletedResult {
  return createReviewResult({ traceLength, decision: "ask_user" });
}

function assertExecutionPrecedesReview(
  trace: readonly TraceEvent[],
  review: ReviewerAgentCompletedResult,
): void {
  // reviewer 收到的快照必须以当前 attempt 的 completion event 收尾；这同时证明
  // 写入已经完成且快照不会包含 reviewer 调用后才产生的生命周期事件。
  const executionIndex = trace.length - 1;
  assert.equal(trace[executionIndex]?.event, "coding_execution_completed");
  for (const check of review.extensions.checks) {
    assert.ok(check.traceReferences.every((reference) => (
      reference >= executionIndex && reference < trace.length
    )));
  }
}

const reviewerMustNotRun = async (): Promise<never> => {
  throw new Error("reviewer must not run");
};

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
    let executionCalls = 0;

    const result = await runCodingMode({
      request: "  Inspect the request  ",
      activeModel: "test-model",
      tracePath: "traces/test.jsonl",
      maxSteps: 3,
      traceWriter,
      classifier: async () => ({
        taskType,
        objective: "Normalized objective",
        reason: "Matched test workflow",
      }),
      executor: async (input) => {
        executionCalls += 1;
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
      reviewer: async ({ trace }) => {
        const review = createPassReview(trace.length);
        assertExecutionPrecedesReview(trace, review);
        return review;
      },
      traceSnapshot: () => traceWriter.snapshot(),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    assert.equal(result.taskType, taskType);
    assert.equal(executionCalls, 1);
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
    reviewer: reviewerMustNotRun,
    traceSnapshot: () => traceWriter.snapshot(),
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

test("appends the exact no-modification disclosure to a noncompliant implementation plan", async () => {
  const traceWriter = new MemoryTraceWriter();

  const result = await runCodingMode({
    request: "Implement login",
    activeModel: "test-model",
    tracePath: "traces/plan.jsonl",
    maxSteps: 3,
    traceWriter,
    classifier: async () => ({
      taskType: "propose_implementation_plan",
      objective: "Plan login implementation",
      reason: "The milestone is read-only",
    }),
    executor: async () => ({
      type: "completed",
      output: "1. Add the route.\n2. Add tests.",
      evidence: [],
    }),
    reviewer: async ({ trace, summary }) => {
      const review = createPassReview(trace.length);
      assertExecutionPrecedesReview(trace, review);
      assert.equal(
        summary,
        "1. Add the route.\n2. Add tests.\n\nNo files were modified.",
      );
      return review;
    },
    traceSnapshot: () => traceWriter.snapshot(),
  });

  assert.equal(
    result.finalOutput,
    "1. Add the route.\n2. Add tests.\n\nNo files were modified.",
  );
  assert.equal(result.stopReason, "implementation_plan_completed");
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
    reviewer: reviewerMustNotRun,
    traceSnapshot: () => traceWriter.snapshot(),
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
      reviewer: reviewerMustNotRun,
      traceSnapshot: () => [],
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
      reviewer: reviewerMustNotRun,
      traceSnapshot: () => traceWriter.snapshot(),
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
      reviewer: reviewerMustNotRun,
      traceSnapshot: () => traceWriter.snapshot(),
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
    reviewer: reviewerMustNotRun,
    traceSnapshot: () => traceWriter.snapshot(),
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

test("revises once and passes reviewer feedback to the executor", async () => {
  const traceWriter = new MemoryTraceWriter();
  const feedbacks: string[][] = [];
  let reviews = 0;

  const result = await runCodingMode({
    request: "Explain the workflow",
    activeModel: "test-model",
    tracePath: "traces/revise.jsonl",
    maxSteps: 3,
    traceWriter,
    classifier: async () => ({
      taskType: "explain_module",
      objective: "Explain the workflow",
      reason: "Explanation requested",
    }),
    executor: async ({ revisionInstructions }) => {
      feedbacks.push([...revisionInstructions]);
      const attempt = feedbacks.length;
      return {
        type: "completed",
        output: attempt === 1 ? "First summary" : "Revised summary",
        evidence: [{
          kind: "file",
          source: "src/runtime/run-workflow.ts",
          summary: `attempt ${attempt}`,
        }],
      };
    },
    reviewer: async ({ trace, summary }) => {
      reviews += 1;
      const review = reviews === 1
        ? createReviseReview(trace.length)
        : createPassReview(trace.length);
      assertExecutionPrecedesReview(trace, review);
      assert.equal(summary, reviews === 1 ? "First summary" : "Revised summary");
      return review;
    },
    traceSnapshot: () => traceWriter.snapshot(),
  });

  assert.equal(feedbacks.length, 2);
  assert.equal(reviews, 2);
  assert.deepEqual(feedbacks, [
    [],
    ["Add the missing trace-backed explanation."],
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "explanation_completed");
  assert.equal(result.completedSteps, 3);
  assert.equal(result.finalOutput, "Revised summary");
});

test("maps ask_user to blocked user_action_required", async () => {
  const traceWriter = new MemoryTraceWriter();

  const result = await runCodingMode({
    request: "Diagnose the protected fixture",
    activeModel: "test-model",
    tracePath: "traces/ask-user.jsonl",
    maxSteps: 3,
    traceWriter,
    classifier: async () => ({
      taskType: "diagnose_test_failure",
      objective: "Diagnose the failure",
      reason: "A protected fixture may be required",
    }),
    executor: async () => ({
      type: "completed",
      output: "Unreviewed diagnosis",
      evidence: [],
    }),
    reviewer: async ({ trace }) => {
      const review = createAskUserReview(trace.length);
      assertExecutionPrecedesReview(trace, review);
      return review;
    },
    traceSnapshot: () => traceWriter.snapshot(),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.stopReason, "user_action_required");
  assert.equal(result.finalOutput, "May I inspect the protected fixture?");
});

test("does not invoke reviewer when executor stops", async () => {
  const traceWriter = new MemoryTraceWriter();
  let reviewerCalls = 0;

  const result = await runCodingMode({
    request: "Diagnose the failure",
    activeModel: "test-model",
    tracePath: "traces/executor-stopped.jsonl",
    maxSteps: 3,
    traceWriter,
    classifier: async () => ({
      taskType: "diagnose_test_failure",
      objective: "Diagnose the failure",
      reason: "A test failed",
    }),
    executor: async () => ({
      type: "stopped",
      status: "blocked",
      reason: "approval_required",
    }),
    reviewer: async () => {
      reviewerCalls += 1;
      return createPassReview(1);
    },
    traceSnapshot: () => traceWriter.snapshot(),
  });

  assert.equal(reviewerCalls, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.stopReason, "approval_required");
  assert.equal(result.finalOutput, null);
});

test("does not report success when reviewer fails or times out", async (t) => {
  for (const [status, expectedReason] of [
    ["failed", "reviewer_failed"],
    ["timed_out", "reviewer_timed_out"],
  ] as const) {
    await t.test(`${status} maps to ${expectedReason}`, async () => {
      const traceWriter = new MemoryTraceWriter();
      let reviewerSawExecution = false;

      const result = await runCodingMode({
        request: "Explain the workflow",
        activeModel: "test-model",
        tracePath: `traces/reviewer-${status}.jsonl`,
        maxSteps: 3,
        traceWriter,
        classifier: async () => ({
          taskType: "explain_module",
          objective: "Explain the workflow",
          reason: "Explanation requested",
        }),
        executor: async () => ({
          type: "completed",
          output: "Unreviewed summary",
          evidence: [],
        }),
        reviewer: async ({ trace }) => {
          reviewerSawExecution = trace.some(
            (event) => event.event === "coding_execution_completed",
          );
          return {
            contractId: "review-coding-attempt-1",
            role: "reviewer-agent",
            status,
            summary: `Reviewer ${status}`,
            evidence: [],
            errors: [{
              code: `reviewer_${status}`,
              message: `Reviewer ${status}`,
              retryable: status === "timed_out",
            }],
          };
        },
        traceSnapshot: () => traceWriter.snapshot(),
      });

      assert.equal(reviewerSawExecution, true);
      assert.equal(result.status, "failed");
      assert.equal(result.stopReason, expectedReason);
      assert.equal(result.finalOutput, null);
    });
  }
});

test("stops a repeated revise loop at maxSteps", async () => {
  const traceWriter = new MemoryTraceWriter();
  let executorCalls = 0;
  let reviewerCalls = 0;

  const result = await runCodingMode({
    request: "Explain the workflow",
    activeModel: "test-model",
    tracePath: "traces/repeated-revise.jsonl",
    maxSteps: 3,
    traceWriter,
    classifier: async () => ({
      taskType: "explain_module",
      objective: "Explain the workflow",
      reason: "Explanation requested",
    }),
    executor: async () => {
      executorCalls += 1;
      return {
        type: "completed",
        output: `Unaccepted summary ${executorCalls}`,
        evidence: [],
      };
    },
    reviewer: async ({ trace }) => {
      reviewerCalls += 1;
      const review = createReviseReview(trace.length);
      assertExecutionPrecedesReview(trace, review);
      return review;
    },
    traceSnapshot: () => traceWriter.snapshot(),
  });

  assert.equal(executorCalls, 2);
  assert.equal(reviewerCalls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "max_workflow_steps_exceeded");
  assert.equal(result.finalOutput, null);
});

test("fails closed when reviewer dependencies are missing", async (t) => {
  for (const missingDependency of ["reviewer", "traceSnapshot"] as const) {
    await t.test(`missing ${missingDependency}`, async () => {
      const traceWriter = new MemoryTraceWriter();
      let classifierCalls = 0;
      let executorCalls = 0;
      const dependencies = missingDependency === "reviewer"
        ? { traceSnapshot: () => traceWriter.snapshot() }
        : { reviewer: async () => createPassReview(1) };

      const result = await runCodingMode({
        request: "Explain the workflow",
        activeModel: "test-model",
        tracePath: `traces/missing-${missingDependency}.jsonl`,
        maxSteps: 3,
        traceWriter,
        classifier: async () => {
          classifierCalls += 1;
          return {
            taskType: "explain_module",
            objective: "Explain the workflow",
            reason: "Explanation requested",
          };
        },
        executor: async () => {
          executorCalls += 1;
          return {
            type: "completed",
            output: "This unreviewed summary must never be accepted",
            evidence: [],
          };
        },
        ...dependencies,
      });

      assert.equal(classifierCalls, 0);
      assert.equal(executorCalls, 0);
      assert.deepEqual(result, {
        status: "failed",
        taskType: null,
        stopReason: "reviewer_failed",
        completedSteps: 0,
        finalOutput: null,
        tracePath: `traces/missing-${missingDependency}.jsonl`,
      });
      assert.deepEqual(traceWriter.events.map((event) => event.event), [
        "coding_run_started",
        "coding_run_stopped",
      ]);
    });
  }
});
