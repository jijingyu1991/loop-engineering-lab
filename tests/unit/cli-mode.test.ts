import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliInvocation } from "../../src/cli.js";

test("parses coding mode with natural-language input", () => {
  assert.deepEqual(
    parseCliInvocation(["coding", "帮我查看", "loop 模块代码"]),
    { mode: "coding", request: "帮我查看 loop 模块代码" },
  );
});

test("keeps the existing default loop invocation", () => {
  assert.deepEqual(
    parseCliInvocation(["Improve", "this task"]),
    { mode: "loop", request: "Improve this task" },
  );
});

test("rejects coding mode without a request", () => {
  assert.throws(
    () => parseCliInvocation(["coding"]),
    /Usage: npm run loop -- coding "your request"/,
  );
});
