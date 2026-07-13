import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveWorkspacePath } from "../../src/agents/tools/resolve-workspace-path.js";

async function createFixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "tool-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "tool-outside-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export {};", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  return { root, outside };
}

test("resolves an existing path and exposes only its workspace-relative name", async () => {
  const fixture = await createFixture();
  try {
    const result = await resolveWorkspacePath({
      workspaceRoot: fixture.root,
      requestedPath: "src/index.ts",
      mode: "existing",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.data.absolutePath,
        await realpath(join(fixture.root, "src/index.ts")),
      );
      assert.equal(result.data.relativePath, "src/index.ts");
      assert.equal(result.evidence.path, "src/index.ts");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.outside, { recursive: true, force: true });
  }
});

test("resolves a new file beneath an existing workspace parent", async () => {
  const fixture = await createFixture();
  try {
    const result = await resolveWorkspacePath({
      workspaceRoot: fixture.root,
      requestedPath: "src/new-file.ts",
      mode: "new-file",
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.relativePath, "src/new-file.ts");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.outside, { recursive: true, force: true });
  }
});

test("rejects parent traversal and absolute paths", async () => {
  const fixture = await createFixture();
  try {
    for (const requestedPath of ["../secret.txt", join(fixture.outside, "secret.txt")]) {
      const result = await resolveWorkspacePath({
        workspaceRoot: fixture.root,
        requestedPath,
        mode: "existing",
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.type, "path_outside_workspace");
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.userActionRequired, false);
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.outside, { recursive: true, force: true });
  }
});

test("rejects a symlink whose real target is outside workspace", async () => {
  const fixture = await createFixture();
  try {
    await symlink(
      join(fixture.outside, "secret.txt"),
      join(fixture.root, "link.txt"),
    );

    const result = await resolveWorkspacePath({
      workspaceRoot: fixture.root,
      requestedPath: "link.txt",
      mode: "existing",
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.type, "path_outside_workspace");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.outside, { recursive: true, force: true });
  }
});

test("returns a structured not_found error for a missing existing path", async () => {
  const fixture = await createFixture();
  try {
    const result = await resolveWorkspacePath({
      workspaceRoot: fixture.root,
      requestedPath: "missing.txt",
      mode: "existing",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.type, "not_found");
      assert.equal(result.error.evidence.path, "missing.txt");
      assert.match(result.error.suggestedNextStep, /path/i);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.outside, { recursive: true, force: true });
  }
});
