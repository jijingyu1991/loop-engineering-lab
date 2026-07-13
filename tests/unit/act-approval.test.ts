import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  type RunToolApprovalItem,
  type Runner,
} from "@openai/agents";

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

function actor(): Agent {
  return new Agent({
    name: "test actor",
    model: "test-model",
    instructions: "test",
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
    { interruptions: [], state, finalOutput: "completed after approval" },
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
    approvalHandler: async () => "approved",
  });

  assert.deepEqual(approved, [item]);
  assert.equal(calls[1], state);
  assert.equal(outcome.data.output, "completed after approval");
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
    { interruptions: [], state, finalOutput: "used another approach" },
  ];
  const runner = {
    run: async () => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected runner call");
      return result;
    },
  } as unknown as Runner;
  const traceWriter = new MemoryTraceWriter();

  await runAct({
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
});
