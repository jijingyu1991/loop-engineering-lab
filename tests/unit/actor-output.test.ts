import assert from "node:assert/strict";
import { test } from "node:test";

import { actorOutputSchema } from "../../src/agents/actor-output.js";

test("accepts every explicit actor outcome", () => {
  for (const outcome of [
    "succeeded",
    "continue",
    "failed",
    "blocked",
    "cancelled",
  ] as const) {
    assert.deepEqual(actorOutputSchema.parse({ output: "result", outcome }), {
      output: "result",
      outcome,
    });
  }
});

test("rejects empty or unstructured actor output", () => {
  assert.equal(actorOutputSchema.safeParse("done").success, false);
  assert.equal(
    actorOutputSchema.safeParse({ output: "", outcome: "succeeded" }).success,
    false,
  );
});
