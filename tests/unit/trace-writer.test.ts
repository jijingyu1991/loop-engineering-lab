import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JsonlTraceWriter } from "../../src/trace/jsonl-trace-writer.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

test("writes one JSON object per line in call order", async () => {
  const path = join(
    tmpdir(),
    `loop-trace-${process.pid}-${Date.now()}-${Math.random()}.jsonl`,
  );
  const writer = new JsonlTraceWriter(path);
  const started: TraceEvent = {
    event: "loop_started",
    timestamp: "2026-07-10T09:00:00.000Z",
    task: "Test task",
    activeModel: "gpt",
  };
  const stopped: TraceEvent = {
    event: "loop_stopped",
    timestamp: "2026-07-10T09:00:03.000Z",
    status: "completed",
    stopReason: "plan_condition_met",
    completedSteps: 3,
  };

  await writer.write(started);
  await writer.write(stopped);

  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEvent);
  assert.deepEqual(lines, [started, stopped]);
});
