import assert from "node:assert/strict";
import { test } from "node:test";

import { RecordingTraceWriter } from "../../src/trace/recording-trace-writer.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import { TraceInfrastructureError } from "../../src/trace/trace-infrastructure-error.js";

const event: TraceEvent = {
  event: "coding_run_started",
  timestamp: "2026-07-20T00:00:00.000Z",
  request: "review it",
  mode: "coding",
  activeModel: "test-model",
};

const secondEvent: TraceEvent = {
  ...event,
  request: "review it again",
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

test("serializes overlapping downstream writes and snapshot recording", async () => {
  const persisted: TraceEvent[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered: (() => void) | undefined;
  const firstWasEntered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const writer = new RecordingTraceWriter({
    write: async (value) => {
      persisted.push(value);
      if (value === event) {
        firstEntered?.();
        await firstBlocked;
      }
    },
  });

  const firstWrite = writer.write(event);
  await firstWasEntered;
  const secondWrite = writer.write(secondEvent);
  await Promise.resolve();
  releaseFirst?.();
  await Promise.all([firstWrite, secondWrite]);

  assert.deepEqual(persisted, [event, secondEvent]);
  assert.deepEqual(writer.snapshot(), persisted);
});

test("continues the serialized queue after one downstream failure", async () => {
  const failure = new Error("first trace unavailable");
  let writes = 0;
  const persisted: TraceEvent[] = [];
  const writer = new RecordingTraceWriter({
    write: async (value) => {
      writes += 1;
      if (writes === 1) {
        throw failure;
      }
      persisted.push(value);
    },
  });

  await assert.rejects(writer.write(event), (error: unknown) => {
    assert.ok(error instanceof TraceInfrastructureError);
    assert.equal(error.cause, failure);
    return true;
  });
  await writer.write(secondEvent);

  assert.deepEqual(persisted, [secondEvent]);
  assert.deepEqual(writer.snapshot(), [secondEvent]);
});
