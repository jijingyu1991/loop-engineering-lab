import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeSearchTool } from "../../src/agents/tools/search-tool.js";
import type { ToolRuntimeConfig } from "../../src/agents/tools/tool-runtime-config.js";

function runtime(
  workspaceRoot: string,
  options: { maxMatches?: number; maxOutputChars?: number } = {},
): ToolRuntimeConfig {
  return {
    workspaceRoot,
    file: { maxReadChars: 100_000 },
    search: {
      maxMatches: options.maxMatches ?? 200,
      maxOutputChars: options.maxOutputChars ?? 20_000,
    },
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
  const root = await mkdtemp(join(tmpdir(), "search-tool-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "first.ts"),
      "const marker = 'a+b';\nconst value = 1;\n",
      "utf8",
    );
    await writeFile(
      join(root, "src", "second.ts"),
      "const value = 2;\n",
      "utf8",
    );
    await writeFile(join(root, "notes.md"), "a+b documentation\n", "utf8");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("searches literal text and returns workspace-relative matches", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "a+b", path: ".", regex: false, glob: null },
      runtime(root),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.data.matches.map((match) => match.path),
        ["notes.md", "src/first.ts"],
      );
      assert.equal(result.data.matches[0]?.line, 1);
      assert.equal(result.evidence.matches, 2);
    }
  });
});

test("supports regex and glob filtering only when requested", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "value\\s*=", path: "src", regex: true, glob: "*.ts" },
      runtime(root),
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.matches.length, 2);
  });
});

test("treats no matches as a successful empty result", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "missing-token", path: ".", regex: false, glob: null },
      runtime(root),
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.matches, []);
  });
});

test("returns invalid_input for an invalid regular expression", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "[", path: ".", regex: true, glob: null },
      runtime(root),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "invalid_input");
      assert.match(String(result.error.evidence.stderr), /regex|unclosed|class/i);
    }
  });
});

test("returns output_limit_exceeded when match count crosses the cap", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "value", path: "src", regex: false, glob: null },
      runtime(root, { maxMatches: 1 }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "output_limit_exceeded");
      assert.equal(result.error.evidence.maxMatches, 1);
    }
  });
});

test("rejects a search root outside the workspace", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "value", path: "..", regex: false, glob: null },
      runtime(root),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "path_outside_workspace");
  });
});

test("returns dependency_missing when ripgrep cannot be started", async () => {
  await withWorkspace(async (root) => {
    const result = await executeSearchTool(
      { pattern: "value", path: ".", regex: false, glob: null },
      runtime(root),
      { executable: "definitely-missing-loop-lab-rg" },
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "dependency_missing");
  });
});
