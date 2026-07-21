import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCodingHandoffArtifact,
} from "../../src/handoff/build-coding-handoff-artifact.js";
import { HANDOFF_LIMITS } from "../../src/handoff/handoff-artifact.js";
import type { CodingRunResult } from "../../src/modes/coding/coding-state.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

function createResult(
  overrides: Partial<CodingRunResult> = {},
): CodingRunResult {
  return {
    status: "completed",
    taskType: "explain_module",
    stopReason: "explanation_completed",
    completedSteps: 3,
    finalOutput: "The workflow is ready for the next change.",
    tracePath: "traces/coding-run.jsonl",
    ...overrides,
  };
}

test("builds a completed handoff from accepted workflow evidence", () => {
  const acceptedEvidence = {
    kind: "file",
    source: "src/cli.ts",
    summary: "Entry point inspected.",
  };
  const trace: TraceEvent[] = [
    {
      event: "workflow_step_completed",
      timestamp: "2026-07-21T00:00:00.000Z",
      step: "understand_request",
      stepIndex: 0,
      evidence: [{
        kind: "classification_objective",
        source: "explain_module",
        summary: "Explain the Coding workflow.",
      }],
    },
    {
      event: "workflow_step_completed",
      timestamp: "2026-07-21T00:00:01.000Z",
      step: "inspect_and_explain",
      stepIndex: 1,
      evidence: [acceptedEvidence, acceptedEvidence],
    },
    {
      event: "coding_run_stopped",
      timestamp: "2026-07-21T00:00:02.000Z",
      status: "completed",
      taskType: "explain_module",
      stopReason: "explanation_completed",
      completedSteps: 2,
    },
  ];

  const artifact = buildCodingHandoffArtifact({
    request: "Explain the Coding workflow",
    result: createResult({ completedSteps: 2 }),
    trace,
  });

  assert.equal(artifact.goal, "Explain the Coding workflow");
  assert.equal(artifact.currentState.status, "completed");
  assert.equal(artifact.currentState.stopReason, "explanation_completed");
  assert.deepEqual(artifact.completedSteps.map((item) => item.step), [
    "understand_request",
    "inspect_and_explain",
  ]);
  assert.deepEqual(artifact.evidence, [
    acceptedEvidence,
    {
      kind: "classification_objective",
      source: "explain_module",
      summary: "Explain the Coding workflow.",
    },
  ]);
  assert.deepEqual(artifact.openQuestions, []);
  assert.deepEqual(artifact.failedAttempts, []);
  assert.equal(
    artifact.nextRecommendedAction,
    "Review the final output and continue with its next action; if none is stated, verify the evidence and close the task.",
  );
});

test("turns a blocked user question into the next recommended action", () => {
  const result = createResult({
    status: "blocked",
    taskType: "diagnose_test_failure",
    stopReason: "user_action_required",
    finalOutput: "May I inspect the protected fixture?",
  });

  const artifact = buildCodingHandoffArtifact({
    request: "Diagnose the protected fixture",
    result,
    trace: [],
  });

  assert.deepEqual(artifact.openQuestions, [
    "May I inspect the protected fixture?",
  ]);
  assert.equal(
    artifact.nextRecommendedAction,
    "Answer the first open question, then rerun the Coding task.",
  );
  assert.equal(artifact.failedAttempts[0]?.kind, "terminal:user_action_required");
});

test("keeps concise failed attempts and prefers the newest suggested action", () => {
  const trace: TraceEvent[] = [
    {
      event: "workflow_step_failed",
      timestamp: "2026-07-21T00:00:00.000Z",
      step: "inspect_and_explain",
      stepIndex: 1,
      error: { name: "Error", message: "Executor failed." },
    },
    {
      event: "tool_failed",
      timestamp: "2026-07-21T00:00:01.000Z",
      tool: "shell",
      operation: "execute",
      durationMs: 20,
      error: {
        type: "process_failed",
        message: "The focused test failed.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Inspect the failing assertion.",
        evidence: {
          stdout: "UNBOUNDED RAW LOG MUST NOT APPEAR",
          OPENAI_API_KEY: "my-secret",
        },
      },
    },
  ];
  const artifact = buildCodingHandoffArtifact({
    request: "Diagnose the test",
    result: createResult({
      status: "failed",
      stopReason: "workflow_step_failed",
      finalOutput: null,
    }),
    trace,
  });

  assert.equal(artifact.failedAttempts[0]?.kind, "tool:shell/execute");
  assert.equal(
    artifact.failedAttempts[0]?.suggestedNextStep,
    "Inspect the failing assertion.",
  );
  assert.equal(
    artifact.nextRecommendedAction,
    "Inspect the failing assertion.",
  );
  assert.doesNotMatch(JSON.stringify(artifact), /UNBOUNDED RAW LOG/);
  assert.doesNotMatch(JSON.stringify(artifact), /my-secret/);
});

test("records reviewer revisions as failed attempts without copying the full result", () => {
  const trace: TraceEvent[] = [{
    event: "subagent_finished",
    timestamp: "2026-07-21T00:00:00.000Z",
    result: {
      contractId: "review-coding-attempt-1",
      role: "reviewer-agent",
      status: "completed",
      summary: "Reviewer requested revision.",
      evidence: [],
      errors: [],
      extensions: {
        decision: "revise",
        checks: [],
        revisionInstructions: ["Add trace-backed failure evidence."],
        ignoredRawPayload: "RAW REVIEW PAYLOAD MUST NOT APPEAR",
      },
    },
  }];

  const artifact = buildCodingHandoffArtifact({
    request: "Explain the workflow",
    result: createResult(),
    trace,
  });

  assert.deepEqual(artifact.failedAttempts, [{
    kind: "reviewer:revise",
    summary: "Reviewer requested revision.",
    suggestedNextStep: "Add trace-backed failure evidence.",
  }]);
  assert.doesNotMatch(JSON.stringify(artifact), /RAW REVIEW PAYLOAD/);
});

test("maps cancelled runs to a deterministic continuation action", () => {
  const artifact = buildCodingHandoffArtifact({
    request: "Inspect the repository",
    result: createResult({
      status: "cancelled",
      stopReason: "runtime_error",
      finalOutput: null,
    }),
    trace: [],
  });

  assert.equal(
    artifact.nextRecommendedAction,
    "Confirm the goal is still valid, then continue after the last completed step.",
  );
});

test("redacts, truncates, deduplicates, and caps handoff content", () => {
  const evidence = Array.from({ length: HANDOFF_LIMITS.evidence + 4 }, (_, index) => ({
    kind: "file",
    source: `src/file-${index}.ts`,
    summary: `${"evidence ".repeat(80)}${index}`,
  }));
  const failures: TraceEvent[] = Array.from(
    { length: HANDOFF_LIMITS.failedAttempts + 4 },
    (_, index) => ({
      event: "tool_failed" as const,
      timestamp: `2026-07-21T00:00:${String(index).padStart(2, "0")}.000Z`,
      tool: "shell" as const,
      operation: `execute-${index}`,
      durationMs: 1,
      error: {
        type: "process_failed" as const,
        message: `${"failure ".repeat(80)}${index}`,
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: `${"inspect ".repeat(80)}${index}`,
        evidence: {},
      },
    }),
  );
  const trace: TraceEvent[] = [
    {
      event: "workflow_step_completed",
      timestamp: "2026-07-21T00:01:00.000Z",
      step: "inspect_and_explain",
      stepIndex: 1,
      evidence: [...evidence, evidence[0]!],
    },
    ...failures,
  ];

  const artifact = buildCodingHandoffArtifact({
    request: `  Explain   this ${"large request ".repeat(300)} sk-test-secret-value OPENAI_API_KEY=my-secret  `,
    result: createResult({
      status: "failed",
      stopReason: "tool_error",
      finalOutput: `Result ${"detail ".repeat(400)}`,
    }),
    trace,
  });

  assert.ok(artifact.goal.length <= HANDOFF_LIMITS.goalChars);
  assert.match(artifact.goal, /… \[truncated\]$/);
  assert.doesNotMatch(artifact.goal, /sk-test-secret-value/);
  assert.doesNotMatch(artifact.goal, /my-secret/);
  assert.equal(artifact.evidence.length, HANDOFF_LIMITS.evidence);
  assert.equal(artifact.failedAttempts.length, HANDOFF_LIMITS.failedAttempts);
  assert.ok(artifact.evidence.every(
    (item) => item.summary.length <= HANDOFF_LIMITS.evidenceChars,
  ));
  assert.ok(artifact.failedAttempts.every(
    (item) => item.summary.length <= HANDOFF_LIMITS.failedAttemptChars,
  ));
});
