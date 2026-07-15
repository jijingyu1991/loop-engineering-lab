import assert from "node:assert/strict";
import { test } from "node:test";

import { readOnlyFileInputSchema } from "../../src/agents/tools/read-only-file-tool.js";

test("accepts file reads", () => {
  assert.deepEqual(
    readOnlyFileInputSchema.parse({ path: "src/cli.ts" }),
    { path: "src/cli.ts" },
  );
});

test("rejects the existing file tool write shape", () => {
  assert.equal(readOnlyFileInputSchema.safeParse({
    action: "write",
    path: "src/new.ts",
    content: "unsafe",
    overwrite: true,
  }).success, false);
});
