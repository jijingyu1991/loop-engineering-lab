import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeFileTool } from "../../src/agents/tools/file-tool.js";
import type { ToolRuntimeConfig } from "../../src/agents/tools/tool-runtime-config.js";

function runtime(workspaceRoot: string, maxReadChars = 100_000): ToolRuntimeConfig {
  return {
    workspaceRoot,
    file: { maxReadChars },
    search: { maxMatches: 200, maxOutputChars: 20_000 },
    shell: {
      allowedExecutables: [],
      approvalRequiredExecutables: [],
      timeoutMs: 10_000,
      maxOutputChars: 20_000,
    },
  };
}

async function withWorkspace(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "file-tool-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads UTF-8 content with bounded evidence", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "note.txt"), "你好 tool", "utf8");

    const result = await executeFileTool(
      { action: "read", path: "note.txt" },
      runtime(root),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.content, "你好 tool");
      assert.equal(result.data.chars, 7);
      assert.equal(result.data.bytes, 11);
      assert.deepEqual(result.evidence, {
        tool: "file",
        operation: "read",
        path: "note.txt",
        chars: 7,
        bytes: 11,
      });
    }
  });
});

test("returns output_limit_exceeded instead of oversized content", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "large.txt"), "123456", "utf8");

    const result = await executeFileTool(
      { action: "read", path: "large.txt" },
      runtime(root, 5),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "output_limit_exceeded");
      assert.equal(result.error.retryable, false);
      assert.match(result.error.suggestedNextStep, /search/i);
      assert.equal(result.error.evidence.path, "large.txt");
    }
  });
});

test("creates a file atomically without copying content into evidence", async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, "src"));

    const result = await executeFileTool(
      {
        action: "write",
        path: "src/new.ts",
        content: "export const value = 1;",
        overwrite: false,
      },
      runtime(root),
    );

    assert.equal(result.ok, true);
    assert.equal(await readFile(join(root, "src/new.ts"), "utf8"), "export const value = 1;");
    if (result.ok) {
      assert.equal(result.evidence.path, "src/new.ts");
      assert.equal("content" in result.evidence, false);
    }
  });
});

test("returns a structured conflict instead of overwriting implicitly", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "answer.txt"), "old", "utf8");

    const result = await executeFileTool(
      {
        action: "write",
        path: "answer.txt",
        content: "new",
        overwrite: false,
      },
      runtime(root),
    );

    assert.equal(result.ok, false);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "old");
    if (!result.ok) {
      assert.equal(result.error.type, "conflict");
      assert.equal(result.error.retryable, false);
      assert.equal(result.error.userActionRequired, false);
      assert.match(result.error.suggestedNextStep, /overwrite/);
      assert.equal(result.error.evidence.path, "answer.txt");
    }
  });
});

test("overwrites only when the caller explicitly opts in", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "answer.txt"), "old", "utf8");

    const result = await executeFileTool(
      {
        action: "write",
        path: "answer.txt",
        content: "new",
        overwrite: true,
      },
      runtime(root),
    );

    assert.equal(result.ok, true);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "new");
  });
});

test("returns not_found when the write parent does not exist", async () => {
  await withWorkspace(async (root) => {
    const result = await executeFileTool(
      {
        action: "write",
        path: "missing/new.txt",
        content: "value",
        overwrite: false,
      },
      runtime(root),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "not_found");
  });
});

test("rejects reading through a symlink to an outside file", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "file-tool-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));

      const result = await executeFileTool(
        { action: "read", path: "secret-link.txt" },
        runtime(root),
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.type, "path_outside_workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
