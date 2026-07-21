import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { generateCodingHandoff } from "../../src/handoff/generate-coding-handoff.js";
import {
  type HandoffFileSystem,
  writeHandoffFile,
} from "../../src/handoff/write-handoff-file.js";
import type { CodingRunResult } from "../../src/modes/coding/coding-state.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";

test("atomically replaces an existing handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coding-handoff-write-"));
  const handoffPath = join(directory, "handoff.md");
  await writeFile(handoffPath, "old handoff\n", "utf8");

  await writeHandoffFile({
    handoffPath,
    markdown: "new handoff\n",
    createId: () => "success",
  });

  assert.equal(await readFile(handoffPath, "utf8"), "new handoff\n");
  assert.deepEqual(await readdir(directory), ["handoff.md"]);
});

test("preserves the previous handoff when the temporary write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coding-handoff-fail-write-"));
  const handoffPath = join(directory, "handoff.md");
  await writeFile(handoffPath, "old handoff\n", "utf8");
  const fileSystem: HandoffFileSystem = {
    mkdir,
    writeFile: async () => {
      throw new Error("disk full");
    },
    rename,
    rm,
  };

  await assert.rejects(
    writeHandoffFile({
      handoffPath,
      markdown: "partial handoff\n",
      fileSystem,
      createId: () => "write-failure",
    }),
    /Failed to write handoff artifact/,
  );

  assert.equal(await readFile(handoffPath, "utf8"), "old handoff\n");
  assert.deepEqual(await readdir(directory), ["handoff.md"]);
});

test("removes the temporary file and preserves the old handoff when rename fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coding-handoff-fail-rename-"));
  const handoffPath = join(directory, "handoff.md");
  await writeFile(handoffPath, "old handoff\n", "utf8");
  const fileSystem: HandoffFileSystem = {
    mkdir,
    writeFile: async (path, data, options) => {
      await writeFile(path, data, options);
    },
    rename: async () => {
      throw new Error("rename unavailable");
    },
    rm,
  };

  await assert.rejects(
    writeHandoffFile({
      handoffPath,
      markdown: "new handoff\n",
      fileSystem,
      createId: () => "rename-failure",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to write handoff artifact/);
      assert.equal((error.cause as Error).message, "rename unavailable");
      return true;
    },
  );

  assert.equal(await readFile(handoffPath, "utf8"), "old handoff\n");
  assert.deepEqual(await readdir(directory), ["handoff.md"]);
});

test("generates a rendered handoff at the workspace root", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "coding-handoff-pipeline-"));
  const result: CodingRunResult = {
    status: "completed",
    taskType: "find_related_files",
    stopReason: "related_files_identified",
    completedSteps: 2,
    finalOutput: "Relevant files were identified.",
    tracePath: "traces/coding-pipeline.jsonl",
  };
  const trace: TraceEvent[] = [{
    event: "workflow_step_completed",
    timestamp: "2026-07-21T00:00:00.000Z",
    step: "inspect_and_explain",
    stepIndex: 1,
    evidence: [{
      kind: "file",
      source: "src/coding-cli.ts",
      summary: "Coding entry point inspected.",
    }],
  }];

  const handoffPath = await generateCodingHandoff({
    request: "Find Coding mode files",
    result,
    trace,
    workspaceRoot,
  });
  const markdown = await readFile(handoffPath, "utf8");

  assert.equal(handoffPath, join(workspaceRoot, "handoff.md"));
  assert.match(markdown, /## Goal\n\nFind Coding mode files/);
  assert.match(markdown, /- Status: `completed`/);
  assert.match(markdown, /`src\/coding-cli\.ts`/);
  assert.doesNotMatch(markdown, /"event":"workflow_step_completed"/);
});
