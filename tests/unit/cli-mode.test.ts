import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliInvocation } from "../../src/cli.js";

test("treats coding as ordinary loop input", () => {
  assert.deepEqual(
    parseCliInvocation(["coding", "帮我查看", "loop 模块代码"]),
    { mode: "loop", request: "coding 帮我查看 loop 模块代码" },
  );
});

test("keeps the existing default loop invocation", () => {
  assert.deepEqual(
    parseCliInvocation(["Improve", "this task"]),
    { mode: "loop", request: "Improve this task" },
  );
});

test("rejects loop mode without a request", () => {
  assert.throws(
    () => parseCliInvocation([]),
    /Usage: npm run loop -- "your task"/,
  );
});
