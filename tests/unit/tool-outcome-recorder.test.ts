import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import { createToolError } from "../../src/agents/tools/tool-result.js";

const first = createToolError({
  type: "timeout",
  message: "timed out",
  retryable: true,
  userActionRequired: false,
  suggestedNextStep: "retry once",
  evidence: { tool: "shell" },
});
const second = createToolError({
  type: "approval_rejected",
  message: "rejected",
  retryable: false,
  userActionRequired: false,
  suggestedNextStep: "use an alternative",
  evidence: { tool: "shell" },
});

test("returns only failures recorded after a checkpoint", () => {
  const recorder = createToolOutcomeRecorder();
  recorder.recordFailure(first);
  const checkpoint = recorder.checkpoint();
  recorder.recordFailure(second);

  assert.deepEqual(recorder.failuresSince(checkpoint), [second]);
  assert.equal(recorder.failuresSince(checkpoint)[0], second);
});

test("rejects a checkpoint outside the current failure sequence", () => {
  const recorder = createToolOutcomeRecorder();

  assert.throws(() => recorder.failuresSince(-1), RangeError);
  assert.throws(() => recorder.failuresSince(1), RangeError);
  assert.throws(() => recorder.failuresSince(0.5), RangeError);
});
