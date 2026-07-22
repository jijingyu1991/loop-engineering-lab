import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInputItem } from "@openai/agents";

import {
  compactCodingContext,
  createPinnedEvidenceId,
} from "../../src/context/compact-coding-context.js";
import {
  groupContextItems,
  measureModelInput,
} from "../../src/context/context-item-groups.js";
import { summarizeFunctionResult } from "../../src/context/summarize-tool-result.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

function createToolGroup(index: number, outputChars = 800): AgentInputItem[] {
  const callId = `call-${index}`;

  return [
    {
      type: "function_call",
      callId,
      name: "workspace_shell",
      arguments: JSON.stringify({
        executable: "npm",
        args: ["test", `${index}`],
      }),
    },
    {
      type: "function_call_result",
      callId,
      name: "workspace_shell",
      status: "completed",
      output: JSON.stringify({
        ok: true,
        data: { stdout: `${index}:${"x".repeat(outputChars)}` },
      }),
    },
  ];
}

const call = {
  type: "function_call" as const,
  callId: "call-1",
  name: "workspace_shell",
  arguments: JSON.stringify({ executable: "npm", args: ["test"] }),
};

const result = {
  type: "function_call_result" as const,
  callId: "call-1",
  name: "workspace_shell",
  status: "completed" as const,
  output: JSON.stringify({ ok: true, data: { stdout: "x".repeat(2_000) } }),
};

const secondCall = {
  type: "function_call" as const,
  callId: "call-2",
  name: "workspace_file",
  arguments: JSON.stringify({ path: "README.md" }),
};

const secondResult = {
  type: "function_call_result" as const,
  callId: "call-2",
  name: "workspace_file",
  status: "completed" as const,
  output: JSON.stringify({ ok: true, data: { path: "README.md" } }),
};

test("measures instructions and input with one canonical JSON serialization", () => {
  const instructions = "Preserve useful evidence.";
  const input: AgentInputItem[] = [
    { role: "user", content: "diagnose" },
    call,
  ];

  assert.equal(
    measureModelInput(instructions, input),
    JSON.stringify({ instructions, input }).length,
  );
});

test("groups a function call and result atomically", () => {
  const groups = groupContextItems([
    { role: "user", content: "diagnose" },
    call,
    result,
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1]?.items, [call, result]);
  assert.equal(groups[1]?.callId, "call-1");
});

test("groups interleaved distinct tool calls without changing source order", () => {
  const input = [call, secondCall, result, secondResult];
  const groups = groupContextItems(input);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "function_tool");
  assert.deepEqual(groups.flatMap((group) => group.items), input);
});

test("rejects an orphan function result", () => {
  assert.throws(
    () => groupContextItems([result]),
    /orphan function result/i,
  );
});

test("rejects a function result that appears before its call", () => {
  assert.throws(
    () => groupContextItems([result, call]),
    /orphan function result/i,
  );
});

test("rejects duplicate function calls", () => {
  assert.throws(
    () => groupContextItems([call, { ...call, arguments: "{}" }, result]),
    /duplicate function call/i,
  );
});

test("rejects duplicate function results", () => {
  assert.throws(
    () => groupContextItems([call, result, { ...result, output: "{}" }]),
    /duplicate function result/i,
  );
});

test("summarizes successful tool output deterministically within its budget", () => {
  const [group] = groupContextItems([call, result]);
  assert.ok(group);

  const first = summarizeFunctionResult(group, 480);
  const second = summarizeFunctionResult(group, 480);
  const output = JSON.parse(String(first.item.output)) as Record<string, unknown>;
  const excerpt = output.excerpt as Record<string, unknown>;

  assert.deepEqual(first, second);
  assert.equal(output.compacted, true);
  assert.equal(output.callId, "call-1");
  assert.equal(output.tool, "workspace_shell");
  assert.equal(output.originalChars, result.output.length);
  assert.equal(typeof output.source, "string");
  assert.equal(typeof excerpt.omittedChars, "number");
  assert.ok(String(first.item.output).length <= 480);
  assert.equal(first.manifest.status, "succeeded");
});

test("preserves required failed-tool evidence or fails closed when it cannot fit", () => {
  const failedResult = {
    type: "function_call_result" as const,
    callId: "call-failed",
    name: "workspace_shell",
    status: "completed" as const,
    output: JSON.stringify({
      ok: false,
      error: {
        type: "process_failed",
        message: "Focused test failed.",
        retryable: true,
        userActionRequired: false,
        suggestedNextStep: "Inspect the assertion diff.",
        evidence: { exitCode: 1, command: "npm test" },
      },
    }),
  };
  const [group] = groupContextItems([
    { ...call, callId: "call-failed" },
    failedResult,
  ]);
  assert.ok(group);

  const summary = summarizeFunctionResult(group, 800);
  const repeatSummary = summarizeFunctionResult(group, 800);
  const output = JSON.parse(String(summary.item.output)) as Record<string, unknown>;
  const error = output.error as Record<string, unknown>;

  assert.deepEqual(error, {
    type: "process_failed",
    message: "Focused test failed.",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Inspect the assertion diff.",
    evidence: { exitCode: 1, command: "npm test" },
  });
  assert.equal(output.conclusion, "attempt_failed");
  assert.ok(String(summary.item.output).length <= 800);
  assert.equal(summary.manifest.status, "failed");
  assert.deepEqual(summary, repeatSummary);

  assert.throws(
    () => summarizeFunctionResult(group, 20),
    (error: unknown) =>
      error instanceof Error &&
      "reason" in error &&
      error.reason === "pinned_content_exceeds_budget",
  );
});

test("returns the original model input without trace when under budget", async () => {
  const modelData = {
    instructions: "rules",
    input: [{ role: "user" as const, content: "task" }],
  };
  const traceWriter = new MemoryTraceWriter();

  const compacted = await compactCodingContext({
    modelData,
    config: {
      maxInputChars: 1_000,
      keepRecentItems: 2,
      maxToolSummaryChars: 200,
    },
    pinnedEvidence: [],
    traceWriter,
    now: () => "2026-07-22T00:00:00.000Z",
  });

  assert.strictEqual(compacted, modelData);
  assert.deepEqual(traceWriter.events, []);
});

test("summarizes older tool groups while preserving the recent window", async () => {
  const toolGroups = [1, 2, 3, 4].map((index) => createToolGroup(index));
  const modelData = {
    instructions: "Keep verified evidence.",
    input: [
      { role: "user" as const, content: "Run the focused checks." },
      ...toolGroups.flat(),
    ],
  };
  const traceWriter = new MemoryTraceWriter();
  const maxInputChars = 3_600;

  assert.ok(
    measureModelInput(modelData.instructions, modelData.input) > maxInputChars,
  );

  const compacted = await compactCodingContext({
    modelData,
    config: {
      maxInputChars,
      keepRecentItems: 2,
      maxToolSummaryChars: 240,
    },
    pinnedEvidence: [],
    traceWriter,
    now: () => "2026-07-22T00:00:00.000Z",
  });
  const compactedGroups = groupContextItems(compacted.input);
  const firstOldResult = compactedGroups[1]?.items.find(
    (item) => item.type === "function_call_result",
  );
  const secondOldResult = compactedGroups[2]?.items.find(
    (item) => item.type === "function_call_result",
  );

  assert.deepEqual(compactedGroups.at(-2)?.items, toolGroups[2]);
  assert.deepEqual(compactedGroups.at(-1)?.items, toolGroups[3]);
  assert.ok(firstOldResult?.type === "function_call_result");
  assert.ok(secondOldResult?.type === "function_call_result");
  assert.match(String(firstOldResult.output), /"compacted":true/);
  assert.match(String(secondOldResult.output), /"compacted":true/);
  assert.deepEqual(
    compacted.input
      .filter((item) => item.type === "function_call")
      .map((item) => item.callId),
    ["call-1", "call-2", "call-3", "call-4"],
  );
  assert.ok(
    measureModelInput(compacted.instructions ?? "", compacted.input) <=
      maxInputChars,
  );
});

test("records stable pinned evidence IDs and preserves an old failed result", async () => {
  const failedCall = {
    type: "function_call" as const,
    callId: "call-failed-old",
    name: "workspace_shell",
    arguments: JSON.stringify({ executable: "npm", args: ["test"] }),
  };
  const requiredError = {
    type: "process_failed",
    message: "Focused test failed.",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Inspect the assertion diff.",
    evidence: { exitCode: 1, command: "npm test" },
  };
  const failedResult = {
    type: "function_call_result" as const,
    callId: "call-failed-old",
    name: "workspace_shell",
    status: "completed" as const,
    output: JSON.stringify({ ok: false, error: requiredError }),
  };
  const pinnedEvidence = [
    {
      kind: "review_decision",
      source: "reviewer",
      summary: "Keep the verified failing assertion.",
    },
  ];
  const recentGroups = [createToolGroup(8), createToolGroup(9)];
  const modelData = {
    instructions: "Keep actionable failures.",
    input: [
      { role: "user" as const, content: "Repair the regression." },
      failedCall,
      failedResult,
      ...createToolGroup(7, 2_500),
      ...recentGroups.flat(),
    ],
  };
  const traceWriter = new MemoryTraceWriter();
  const maxInputChars = 4_000;

  assert.ok(
    measureModelInput(modelData.instructions, modelData.input) > maxInputChars,
  );

  const compacted = await compactCodingContext({
    modelData,
    config: {
      maxInputChars,
      keepRecentItems: 2,
      maxToolSummaryChars: 800,
    },
    pinnedEvidence,
    traceWriter,
    now: () => "2026-07-22T00:00:00.000Z",
  });
  const failedOutputItem = compacted.input.find(
    (item) => item.type === "function_call_result" && item.callId === "call-failed-old",
  );
  assert.ok(failedOutputItem?.type === "function_call_result");
  const failedOutput = JSON.parse(
    String(failedOutputItem.output),
  ) as Record<string, unknown>;

  assert.deepEqual(failedOutput.error, requiredError);
  assert.equal(failedOutput.conclusion, "attempt_failed");
  assert.deepEqual(
    traceWriter.events.map((event) => event.event),
    ["context_compaction_started", "context_compaction_completed"],
  );

  const completed = traceWriter.events[1];
  assert.ok(completed?.event === "context_compaction_completed");
  const evidenceId = createPinnedEvidenceId(pinnedEvidence[0]!);
  assert.equal(evidenceId, "b6fab9e48b62cb86");
  assert.match(evidenceId, /^[a-f0-9]{16}$/);
  assert.equal(evidenceId, createPinnedEvidenceId({ ...pinnedEvidence[0]! }));
  assert.deepEqual(completed.pinnedEvidenceIds, [evidenceId]);
  assert.ok(
    completed.summaries.some(
      (summary) =>
        summary.callId === "call-failed-old" && summary.status === "failed",
    ),
  );
});

test("writes started then failed when protected groups exceed the budget", async () => {
  const traceWriter = new MemoryTraceWriter();
  const modelData = {
    instructions: "Protected instructions.",
    input: [
      { role: "user" as const, content: `initial:${"i".repeat(900)}` },
      { role: "user" as const, content: `recent-a:${"a".repeat(900)}` },
      { role: "user" as const, content: `recent-b:${"b".repeat(900)}` },
    ],
  };

  await assert.rejects(
    () => compactCodingContext({
      modelData,
      config: {
        maxInputChars: 1_000,
        keepRecentItems: 2,
        maxToolSummaryChars: 200,
      },
      pinnedEvidence: [],
      traceWriter,
      now: () => "2026-07-22T00:00:00.000Z",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "reason" in error &&
      error.reason === "pinned_content_exceeds_budget",
  );

  assert.deepEqual(
    traceWriter.events.map((event) => event.event),
    ["context_compaction_started", "context_compaction_failed"],
  );
  const failed = traceWriter.events[1];
  assert.ok(failed?.event === "context_compaction_failed");
  assert.equal(failed.reason, "pinned_content_exceeds_budget");
});

test("rejects instead of returning model data when completed trace persistence fails", async () => {
  const traceFailure = new Error("trace storage unavailable");
  const traceWriter = new class extends MemoryTraceWriter {
    public override async write(event: TraceEvent): Promise<void> {
      if (event.event === "context_compaction_completed") {
        throw traceFailure;
      }

      await super.write(event);
    }
  }();
  const modelData = {
    instructions: "rules",
    input: [
      { role: "user" as const, content: "task" },
      ...createToolGroup(10, 2_500),
      ...createToolGroup(11, 300),
    ],
  };

  await assert.rejects(
    () => compactCodingContext({
      modelData,
      config: {
        maxInputChars: 1_500,
        keepRecentItems: 1,
        maxToolSummaryChars: 240,
      },
      pinnedEvidence: [],
      traceWriter,
      now: () => "2026-07-22T00:00:00.000Z",
    }),
    (error: unknown) => error === traceFailure,
  );
  assert.deepEqual(
    traceWriter.events.map((event) => event.event),
    ["context_compaction_started"],
  );
});

test("compacts an interleaved parallel tool batch without reordering or splitting it", async () => {
  const callA = {
    type: "function_call" as const,
    callId: "parallel-a",
    name: "workspace_file",
    arguments: JSON.stringify({ path: "a.ts" }),
  };
  const callB = {
    type: "function_call" as const,
    callId: "parallel-b",
    name: "workspace_file",
    arguments: JSON.stringify({ path: "b.ts" }),
  };
  const resultA = {
    type: "function_call_result" as const,
    callId: "parallel-a",
    name: "workspace_file",
    status: "completed" as const,
    output: JSON.stringify({
      ok: true,
      data: { content: `a:${"a".repeat(1_500)}` },
    }),
  };
  const resultB = {
    type: "function_call_result" as const,
    callId: "parallel-b",
    name: "workspace_file",
    status: "completed" as const,
    output: JSON.stringify({
      ok: true,
      data: { content: `b:${"b".repeat(1_500)}` },
    }),
  };
  const compacted = await compactCodingContext({
    modelData: {
      instructions: "Keep source order.",
      input: [
        { role: "user", content: "Read both files." },
        callA,
        callB,
        resultA,
        resultB,
        ...createToolGroup(12),
        ...createToolGroup(13),
      ],
    },
    config: {
      maxInputChars: 3_600,
      keepRecentItems: 2,
      maxToolSummaryChars: 240,
    },
    pinnedEvidence: [],
    traceWriter: new MemoryTraceWriter(),
    now: () => "2026-07-22T00:00:00.000Z",
  });
  const groups = groupContextItems(compacted.input);
  const parallelGroup = groups[1];

  assert.equal(parallelGroup?.kind, "function_tool");
  assert.equal(parallelGroup?.items.length, 4);
  assert.deepEqual(
    parallelGroup?.items.map((item) => ({
      type: item.type,
      callId: "callId" in item ? item.callId : undefined,
    })),
    [
      { type: "function_call", callId: "parallel-a" },
      { type: "function_call", callId: "parallel-b" },
      { type: "function_call_result", callId: "parallel-a" },
      { type: "function_call_result", callId: "parallel-b" },
    ],
  );
  assert.equal(parallelGroup?.callId, undefined);
  assert.equal(parallelGroup?.functionName, undefined);
  assert.ok(
    measureModelInput(compacted.instructions ?? "", compacted.input) <= 3_600,
  );
});
