import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  type RunToolApprovalItem,
  type Runner,
} from "@openai/agents";

import {
  actorOutputSchema,
  type ActorOutput,
} from "../../src/agents/actor-output.js";
import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import { runAct } from "../../src/loop/stages/act.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

function approvalItem(): RunToolApprovalItem {
  return {
    name: "workspace_shell",
    arguments: JSON.stringify({
      executable: "git",
      args: ["push", "origin", "main"],
      cwd: ".",
    }),
    rawItem: {
      type: "function_call",
      callId: "call-1",
      name: "workspace_shell",
      arguments: JSON.stringify({
        executable: "git",
        args: ["push", "origin", "main"],
        cwd: ".",
      }),
    },
  } as unknown as RunToolApprovalItem;
}

function actor() {
  return Agent.create({
    name: "test actor",
    model: "test-model",
    instructions: "test",
    outputType: actorOutputSchema,
  });
}

async function runRejectedAct(
  finalOutput: ActorOutput,
  decision: "rejected" | "unavailable",
) {
  const item = approvalItem();
  const state = {
    approve: () => undefined,
    reject: () => undefined,
  };
  const results = [
    { interruptions: [item], state, finalOutput: undefined },
    { interruptions: [], state, finalOutput },
  ];
  const runner = {
    run: async () => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected runner call");
      return result;
    },
  } as unknown as Runner;

  return runAct({
    runner,
    agent: actor(),
    observation: {
      task: "complete safely",
      previousAction: null,
      previousReflection: null,
    },
    plan: {
      nextAction: "perform the operation",
      stopCondition: { description: "operation completes" },
    },
    maxTurns: 5,
    traceWriter: new MemoryTraceWriter(),
    outcomeRecorder: createToolOutcomeRecorder(),
    approvalHandler: async () => decision,
  });
}

test("approves an interruption and resumes the same RunState", async () => {
  const item = approvalItem();
  const approved: RunToolApprovalItem[] = [];
  const state = {
    approve: (value: RunToolApprovalItem) => approved.push(value),
    reject: () => undefined,
  };
  const calls: unknown[] = [];
  const results = [
    { interruptions: [item], state, finalOutput: undefined },
    {
      interruptions: [],
      state,
      finalOutput: {
        output: "completed after approval",
        outcome: "succeeded" as const,
      },
    },
  ];
  const runner = {
    run: async (_agent: Agent, runInput: unknown) => {
      calls.push(runInput);
      const result = results.shift();
      if (!result) throw new Error("Unexpected runner call");
      return result;
    },
  } as unknown as Runner;
  const traceWriter = new MemoryTraceWriter();

  const outcome = await runAct({
    runner,
    agent: actor(),
    observation: {
      task: "push safely",
      previousAction: null,
      previousReflection: null,
    },
    plan: {
      nextAction: "push",
      stopCondition: { description: "push completes" },
    },
    maxTurns: 5,
    traceWriter,
    outcomeRecorder: createToolOutcomeRecorder(),
    approvalHandler: async () => "approved",
  });

  assert.deepEqual(approved, [item]);
  assert.equal(calls[1], state);
  assert.equal(outcome.data.output, "completed after approval");
  assert.equal(outcome.data.outcome, "succeeded");
  assert.deepEqual(outcome.data.toolErrors, []);
  assert.deepEqual(
    traceWriter.events
      .filter((event) => event.event.startsWith("tool_approval"))
      .map((event) => event.event),
    ["tool_approval_requested", "tool_approval_resolved"],
  );
});

test("rejects unavailable approval with a structured model-visible contract", async () => {
  const item = approvalItem();
  let rejectionMessage: string | undefined;
  const state = {
    approve: () => undefined,
    reject: (
      _value: RunToolApprovalItem,
      options?: { message?: string },
    ) => {
      rejectionMessage = options?.message;
    },
  };
  const results = [
    { interruptions: [item], state, finalOutput: undefined },
    {
      interruptions: [],
      state,
      finalOutput: {
        output: "interactive approval is still required",
        outcome: "blocked" as const,
      },
    },
  ];
  const runner = {
    run: async () => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected runner call");
      return result;
    },
  } as unknown as Runner;
  const traceWriter = new MemoryTraceWriter();

  const outcome = await runAct({
    runner,
    agent: actor(),
    observation: {
      task: "push safely",
      previousAction: null,
      previousReflection: null,
    },
    plan: {
      nextAction: "push",
      stopCondition: { description: "push completes" },
    },
    maxTurns: 5,
    traceWriter,
    outcomeRecorder: createToolOutcomeRecorder(),
    approvalHandler: async () => "unavailable",
  });

  const parsed = JSON.parse(rejectionMessage ?? "null") as {
    ok: boolean;
    error: {
      type: string;
      retryable: boolean;
      userActionRequired: boolean;
      suggestedNextStep: string;
      evidence: unknown;
    };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.type, "approval_required");
  assert.equal(parsed.error.retryable, false);
  assert.equal(parsed.error.userActionRequired, true);
  assert.ok(parsed.error.suggestedNextStep);
  assert.ok(parsed.error.evidence);

  const failed = traceWriter.events.find((event) => event.event === "tool_failed");
  assert.equal(failed?.event, "tool_failed");
  if (failed?.event === "tool_failed") {
    assert.deepEqual(failed.error, parsed.error);
  }
  assert.equal(outcome.data.outcome, "blocked");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_required");
  assert.equal(outcome.decision.nextStep, "stop");
});

test("allows a rejected command to recover through a successful alternative", async () => {
  const outcome = await runRejectedAct(
    { output: "used allowed alternative", outcome: "succeeded" },
    "rejected",
  );

  assert.equal(outcome.data.outcome, "succeeded");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_rejected");
  assert.equal(outcome.decision.nextStep, "verify");
});

test("routes a rejected command with no fallback directly to stop", async () => {
  const outcome = await runRejectedAct(
    {
      output: "user rejected the required operation",
      outcome: "cancelled",
    },
    "rejected",
  );

  assert.equal(outcome.data.outcome, "cancelled");
  assert.equal(outcome.data.toolErrors[0]?.type, "approval_rejected");
  assert.equal(outcome.decision.nextStep, "stop");
});
