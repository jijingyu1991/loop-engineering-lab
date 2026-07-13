import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeShellTool } from "../../src/agents/tools/shell-tool.js";
import type { ToolRuntimeConfig } from "../../src/agents/tools/tool-runtime-config.js";

function runtime(
  workspaceRoot: string,
  options: {
    allowed?: { executable: string; argsPrefix: string[] }[];
    approval?: { executable: string; argsPrefix: string[] }[];
    timeoutMs?: number;
    maxOutputChars?: number;
  } = {},
): ToolRuntimeConfig {
  return {
    workspaceRoot,
    file: { maxReadChars: 100_000 },
    search: { maxMatches: 200, maxOutputChars: 20_000 },
    shell: {
      allowedExecutables: options.allowed ?? [
        { executable: process.execPath, argsPrefix: [] },
      ],
      approvalRequiredExecutables: options.approval ?? [],
      timeoutMs: options.timeoutMs ?? 1000,
      maxOutputChars: options.maxOutputChars ?? 20_000,
    },
  };
}

async function withWorkspace(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shell-tool-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("executes an allowed command with argument boundaries and separate output", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("out"); process.stderr.write("err");',
        ],
        cwd: ".",
      },
      runtime(root),
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.stdout, "out");
      assert.equal(result.data.stderr, "err");
      assert.equal(result.data.exitCode, 0);
      assert.equal(result.evidence.cwd, ".");
    }
  });
});

test("returns command_not_allowed for an unmatched command", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      { executable: "git", args: ["clean", "-fd"], cwd: "." },
      runtime(root, { allowed: [] }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "command_not_allowed");
      assert.equal(result.error.userActionRequired, false);
    }
  });
});

test("requires approval before an approval-required command executes", async () => {
  await withWorkspace(async (root) => {
    const configured = runtime(root, {
      allowed: [],
      approval: [{ executable: process.execPath, argsPrefix: [] }],
    });
    const input = {
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("approved")'],
      cwd: ".",
    };

    const pending = await executeShellTool(input, configured);
    assert.equal(pending.ok, false);
    if (!pending.ok) {
      assert.equal(pending.error.type, "approval_required");
      assert.equal(pending.error.userActionRequired, true);
    }

    const approved = await executeShellTool(input, configured, {
      approvalGranted: true,
    });
    assert.equal(approved.ok, true);
    if (approved.ok) assert.equal(approved.data.stdout, "approved");
  });
});

test("rejects workspace escape before considering approval", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      { executable: process.execPath, args: ["-e", ""], cwd: ".." },
      runtime(root, {
        allowed: [],
        approval: [{ executable: process.execPath, argsPrefix: [] }],
      }),
      { approvalGranted: true },
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "path_outside_workspace");
  });
});

test("returns stdout and stderr evidence for a nonzero exit", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("context"); process.stderr.write("failure"); process.exit(7);',
        ],
        cwd: ".",
      },
      runtime(root),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "process_failed");
      assert.equal(result.error.evidence.exitCode, 7);
      assert.equal(result.error.evidence.stdout, "context");
      assert.equal(result.error.evidence.stderr, "failure");
    }
  });
});

test("classifies a timeout as retryable", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      {
        executable: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 1000)"],
        cwd: ".",
      },
      runtime(root, { timeoutMs: 20 }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "timeout");
      assert.equal(result.error.retryable, true);
    }
  });
});

test("stops output that exceeds the configured cap", async () => {
  await withWorkspace(async (root) => {
    const result = await executeShellTool(
      {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("123456789")'],
        cwd: ".",
      },
      runtime(root, { maxOutputChars: 5 }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "output_limit_exceeded");
      assert.equal(result.error.evidence.maxOutputChars, 5);
    }
  });
});

test("returns dependency_missing when an allowed executable is absent", async () => {
  await withWorkspace(async (root) => {
    const executable = "definitely-missing-loop-lab-command";
    const result = await executeShellTool(
      { executable, args: [], cwd: "." },
      runtime(root, {
        allowed: [{ executable, argsPrefix: [] }],
      }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "dependency_missing");
  });
});
