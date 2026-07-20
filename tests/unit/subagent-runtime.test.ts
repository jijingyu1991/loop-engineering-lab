import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  SubagentContract,
  SubagentResult,
} from "../../src/domain/subagent-contract.js";
import {
  SubagentMaxStepsExceededError,
  type SubagentInvocationInput,
} from "../../src/subagents/subagent-invoker.js";
import { runSubagent } from "../../src/subagents/run-subagent.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

const contract: SubagentContract = {
  id: "review-coding-attempt-1",
  role: "reviewer-agent",
  task: "Review the executor summary against the supplied trace.",
  scope: {
    include: ["traces"],
    exclude: [],
    constraints: ["Use only context items; do not execute tools or modify files."],
  },
  allowedTools: [],
  contextPackage: {
    items: [{
      id: "coding-trace",
      kind: "trace",
      source: "runtime",
      content: "[]",
    }],
    maxChars: 1_000,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return a trace-backed review decision."],
  },
  evidenceRequirements: {
    requiredKinds: ["review_decision"],
    minimumCount: 1,
  },
  limits: { timeoutMs: 100, maxSteps: 8 },
};

const validResult: SubagentResult = {
  contractId: contract.id,
  role: contract.role,
  status: "completed",
  summary: "The executor summary is supported by the trace.",
  evidence: [{
    kind: "review_decision",
    source: contract.id,
    summary: "pass",
  }],
  errors: [],
};

class TestTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

test("passes contract capabilities and budgets to the invoker", async () => {
  const received: SubagentInvocationInput[] = [];
  const traceWriter = new TestTraceWriter();
  const result = await runSubagent({
    contract,
    traceWriter,
    now: () => "2026-07-20T00:00:00.000Z",
    invoker: async (input) => {
      received.push(input);
      return validResult;
    },
  });

  assert.deepEqual(result, validResult);
  assert.deepEqual(received[0]?.allowedTools, []);
  assert.equal(received[0]?.maxSteps, contract.limits.maxSteps);
  assert.equal(received[0]?.signal.aborted, false);
  assert.deepEqual(traceWriter.events.map((event) => event.event), [
    "subagent_started",
    "subagent_finished",
  ]);
  assert.deepEqual(traceWriter.events[0], {
    event: "subagent_started",
    timestamp: "2026-07-20T00:00:00.000Z",
    contractId: contract.id,
    role: contract.role,
    contextItemIds: ["coding-trace"],
    allowedTools: [],
    limits: contract.limits,
  });
});

test("aborts and returns timed_out when the invocation exceeds timeoutMs", async () => {
  const shortContract = {
    ...contract,
    limits: { ...contract.limits, timeoutMs: 5 },
  };
  const traceWriter = new TestTraceWriter();
  let invocationSignal: AbortSignal | undefined;
  const result = await runSubagent({
    contract: shortContract,
    traceWriter,
    invoker: ({ signal }) => {
      invocationSignal = signal;
      return new Promise(() => {});
    },
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.errors[0]?.code, "subagent_timeout");
  assert.equal(invocationSignal?.aborted, true);
});

test("normalizes maxSteps exhaustion as a structured failure", async () => {
  const traceWriter = new TestTraceWriter();
  const result = await runSubagent({
    contract,
    traceWriter,
    invoker: async () => { throw new SubagentMaxStepsExceededError(); },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errors[0]?.code, "subagent_max_steps_exceeded");
});

test("normalizes invalid model output instead of accepting success", async () => {
  const traceWriter = new TestTraceWriter();
  const result = await runSubagent({
    contract,
    traceWriter,
    invoker: async () => "pass",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errors[0]?.code, "subagent_invalid_result");
});

test("normalizes invocation failures without exposing their details", async () => {
  const traceWriter = new TestTraceWriter();
  const result = await runSubagent({
    contract,
    traceWriter,
    invoker: async () => { throw new Error("provider secret"); },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errors[0]?.code, "subagent_invocation_failed");
  assert.doesNotMatch(result.summary, /provider secret/);
});

test("does not swallow lifecycle trace failures", async () => {
  await assert.rejects(runSubagent({
    contract,
    traceWriter: {
      write: async () => { throw new Error("trace unavailable"); },
    },
    invoker: async () => validResult,
  }), /trace unavailable/);
});
