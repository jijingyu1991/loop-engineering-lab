import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";

import { createTerminalApprovalHandler } from "../../src/agents/terminal-approval-handler.js";

function capturedOutput(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    value += chunk;
  });
  return { stream, read: () => value };
}

test("approves only an explicit y or yes response", async () => {
  for (const answer of ["y\n", "YES\n"]) {
    const output = capturedOutput();
    const handler = createTerminalApprovalHandler({
      input: Readable.from([answer]),
      output: output.stream,
      isTTY: true,
    });

    const decision = await handler({
      executable: "git",
      args: ["push", "origin", "main"],
      cwd: ".",
    });

    assert.equal(decision, "approved");
    assert.match(output.read(), /git push origin main/);
    assert.match(output.read(), /\[y\/N\]/);
  }
});

test("defaults empty and unrecognized terminal input to rejected", async () => {
  for (const answer of ["\n", "later\n", "n\n"]) {
    const handler = createTerminalApprovalHandler({
      input: Readable.from([answer]),
      output: new PassThrough(),
      isTTY: true,
    });

    assert.equal(
      await handler({ executable: "npm", args: ["install"], cwd: "." }),
      "rejected",
    );
  }
});

test("non-TTY approval is unavailable without reading or blocking", async () => {
  const input = new PassThrough();
  const handler = createTerminalApprovalHandler({
    input,
    output: new PassThrough(),
    isTTY: false,
  });

  assert.equal(
    await handler({ executable: "git", args: ["push"], cwd: "." }),
    "unavailable",
  );
});
