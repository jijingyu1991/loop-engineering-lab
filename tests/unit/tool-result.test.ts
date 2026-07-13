import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolError } from "../../src/agents/tools/tool-result.js";

test("creates every error with the complete model-visible contract", () => {
  const error = createToolError({
    type: "timeout",
    message: "Command timed out",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Retry once or narrow the command.",
    evidence: {
      tool: "shell",
      operation: "execute",
      durationMs: 10_000,
    },
  });

  assert.deepEqual(error, {
    type: "timeout",
    message: "Command timed out",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Retry once or narrow the command.",
    evidence: {
      tool: "shell",
      operation: "execute",
      durationMs: 10_000,
    },
  });
});
