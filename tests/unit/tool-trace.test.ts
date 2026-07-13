import assert from "node:assert/strict";
import { test } from "node:test";

import { traceToolExecution } from "../../src/agents/tools/trace-tool-execution.js";
import { createToolError } from "../../src/agents/tools/tool-result.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

function sequence<T>(values: T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Test sequence exhausted");
    index += 1;
    return value;
  };
}

test("writes started and completed events around a successful tool result", async () => {
  const traceWriter = new MemoryTraceWriter();
  const result = await traceToolExecution({
    tool: "file",
    operation: "read",
    inputSummary: { path: "README.md" },
    traceWriter,
    now: sequence([
      "2026-07-13T10:00:00.000Z",
      "2026-07-13T10:00:00.005Z",
    ]),
    clock: sequence([100, 105]),
    execute: async () => ({
      ok: true,
      data: { content: "hello" },
      evidence: { path: "README.md", chars: 5 },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(traceWriter.events, [
    {
      event: "tool_started",
      timestamp: "2026-07-13T10:00:00.000Z",
      tool: "file",
      operation: "read",
      input: { path: "README.md" },
    },
    {
      event: "tool_completed",
      timestamp: "2026-07-13T10:00:00.005Z",
      tool: "file",
      operation: "read",
      durationMs: 5,
      evidence: { path: "README.md", chars: 5 },
    },
  ]);
});

test("writes the same structured retry basis returned to the Agent", async () => {
  const traceWriter = new MemoryTraceWriter();
  const error = createToolError({
    type: "timeout",
    message: "Command timed out.",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Retry once with a narrower command.",
    evidence: { executable: "node", durationMs: 1000 },
  });

  const result = await traceToolExecution({
    tool: "shell",
    operation: "execute",
    inputSummary: { executable: "node", cwd: "." },
    traceWriter,
    now: sequence([
      "2026-07-13T10:00:00.000Z",
      "2026-07-13T10:00:01.000Z",
    ]),
    clock: sequence([0, 1000]),
    execute: async () => ({ ok: false, error }),
  });

  assert.deepEqual(result, { ok: false, error });
  const failed = traceWriter.events.at(-1);
  assert.equal(failed?.event, "tool_failed");
  if (failed?.event === "tool_failed") {
    assert.deepEqual(failed.error, error);
    assert.equal(failed.error.retryable, true);
    assert.equal(failed.error.suggestedNextStep, error.suggestedNextStep);
  }
});

test("does not hide a trace write failure", async () => {
  const traceWriter: TraceWriter = {
    write: async () => {
      throw new Error("trace unavailable");
    },
  };

  await assert.rejects(
    () =>
      traceToolExecution({
        tool: "search",
        operation: "search",
        inputSummary: { pattern: "contract" },
        traceWriter,
        execute: async () => ({
          ok: true,
          data: { matches: [] },
          evidence: { matches: 0 },
        }),
      }),
    /trace unavailable/,
  );
});
