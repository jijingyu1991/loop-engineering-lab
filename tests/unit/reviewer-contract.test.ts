import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReviewerAgentContract,
  validateReviewerAgentCompletedResult,
} from "../../src/subagents/reviewer/reviewer-contract.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

const trace: TraceEvent[] = [{
  event: "coding_run_started",
  timestamp: "2026-07-20T00:00:00.000Z",
  request: "explain loop",
  mode: "coding",
  activeModel: "test-model",
}];

const passExtensions = {
  decision: "pass" as const,
  checks: [
    {
      criterion: "conclusion_evidence" as const,
      status: "passed" as const,
      summary: "Claims cite trace.",
      traceReferences: [0],
    },
    {
      criterion: "failure_disclosure" as const,
      status: "passed" as const,
      summary: "No failure was omitted.",
      traceReferences: [0],
    },
    {
      criterion: "required_validation" as const,
      status: "passed" as const,
      summary: "Required validation is present.",
      traceReferences: [0],
    },
  ],
  revisionInstructions: [],
};

function createPassResult(contractId: string) {
  return {
    contractId,
    role: "reviewer-agent" as const,
    status: "completed" as const,
    summary: "The summary passes review.",
    evidence: [
      { kind: "review_decision", source: contractId, summary: "pass" },
      {
        kind: "trace_reference",
        source: "coding-trace",
        summary: "Referenced trace index 0.",
      },
    ],
    errors: [],
    extensions: passExtensions,
  };
}

test("builds a tool-free reviewer contract from trace and summary", () => {
  const contract = createReviewerAgentContract({
    attempt: 1,
    trace,
    summary: "Done.",
  });

  assert.equal(contract.id, "review-coding-attempt-1");
  assert.deepEqual(contract.allowedTools, []);
  assert.deepEqual(contract.scope.include, ["traces"]);
  assert.deepEqual(contract.contextPackage.items.map((item) => item.id), [
    "coding-trace",
    "executor-summary",
  ]);
});

test("validates a completed pass result and its trace references", () => {
  const contract = createReviewerAgentContract({
    attempt: 1,
    trace,
    summary: "Done.",
  });
  const result = createPassResult(contract.id);

  assert.deepEqual(
    validateReviewerAgentCompletedResult(contract, result, trace.length),
    result,
  );
});

test("rejects reviewer decisions that omit a required check", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });
  const result = createPassResult(contract.id);

  assert.throws(() => validateReviewerAgentCompletedResult(contract, {
    ...result,
    extensions: { ...passExtensions, checks: passExtensions.checks.slice(0, 2) },
  }, trace.length));
});

test("rejects reviewer trace references outside the frozen snapshot", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });
  const result = createPassResult(contract.id);

  assert.throws(() => validateReviewerAgentCompletedResult(contract, {
    ...result,
    extensions: {
      ...passExtensions,
      checks: passExtensions.checks.map((check, index) => (
        index === 0 ? { ...check, traceReferences: [trace.length] } : check
      )),
    },
  }, trace.length));
});

test("rejects revise decisions without revision instructions", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });
  const result = createPassResult(contract.id);

  assert.throws(() => validateReviewerAgentCompletedResult(contract, {
    ...result,
    extensions: {
      ...passExtensions,
      decision: "revise",
      revisionInstructions: [],
    },
  }, trace.length));
});

test("rejects ask_user decisions without a question", () => {
  const contract = createReviewerAgentContract({ attempt: 1, trace, summary: "Done." });
  const result = createPassResult(contract.id);

  assert.throws(() => validateReviewerAgentCompletedResult(contract, {
    ...result,
    extensions: {
      ...passExtensions,
      decision: "ask_user",
      userQuestion: undefined,
    },
  }, trace.length));
});

test("rejects context that exceeds the reviewer budget instead of truncating it", () => {
  assert.throws(() => createReviewerAgentContract({
    attempt: 1,
    trace,
    summary: "Done.",
    maxChars: 1,
  }));
});
