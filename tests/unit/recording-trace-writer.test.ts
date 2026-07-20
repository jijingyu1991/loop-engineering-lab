import assert from "node:assert/strict";
import { test } from "node:test";

import { RecordingTraceWriter } from "../../src/trace/recording-trace-writer.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

const event: TraceEvent = {
  event: "coding_run_started",
  timestamp: "2026-07-20T00:00:00.000Z",
  request: "review it",
  mode: "coding",
  activeModel: "test-model",
};

test("records an event only after the downstream writer succeeds", async () => {
  const persisted: TraceEvent[] = [];
  const writer = new RecordingTraceWriter({
    write: async (value) => { persisted.push(value); },
  });

  await writer.write(event);

  assert.deepEqual(persisted, [event]);
  assert.deepEqual(writer.snapshot(), [event]);
  assert.notEqual(writer.snapshot(), writer.snapshot());
});

test("does not expose an event rejected by the downstream writer", async () => {
  const writer = new RecordingTraceWriter({
    write: async () => { throw new Error("trace unavailable"); },
  });

  await assert.rejects(writer.write(event), /trace unavailable/);
  assert.deepEqual(writer.snapshot(), []);
});
