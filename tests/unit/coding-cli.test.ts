import assert from "node:assert/strict";
import { test } from "node:test";

test("parses a standalone coding request", async () => {
  const { parseCodingRequest } = await import("../../src/coding-cli.js");

  assert.equal(
    parseCodingRequest(["帮我查看", "loop 模块代码"]),
    "帮我查看 loop 模块代码",
  );
});

test("rejects an empty standalone coding request", async () => {
  const { parseCodingRequest } = await import("../../src/coding-cli.js");

  assert.throws(
    () => parseCodingRequest([]),
    /Usage: npm run coding -- "your request"/,
  );
});
