import assert from "node:assert/strict";
import { test } from "node:test";

import { disableSdkTracing } from "../../src/agents/disable-sdk-tracing.js";

test("disables the Agents SDK global trace provider", () => {
  const calls: boolean[] = [];

  disableSdkTracing((disabled) => calls.push(disabled));

  assert.deepEqual(calls, [true]);
});
