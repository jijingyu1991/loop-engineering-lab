import assert from "node:assert/strict";
import { access, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { createRunTraceWriter } from "../../src/trace/create-run-trace-writer.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("creates a timestamped file from the configured base path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-trace-name-"));

  const result = await createRunTraceWriter({
    basePath: join(directory, "loop.jsonl"),
    maxFiles: 20,
    now: () => new Date("2026-07-13T08:30:00.123Z"),
  });

  assert.equal(
    basename(result.tracePath),
    "loop-2026-07-13T08-30-00-123Z.jsonl",
  );
  assert.equal(await exists(result.tracePath), true);
});

test("keeps only the newest 20 matching traces and preserves other files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-trace-retention-"));
  const oldestPath = join(directory, "loop-oldest.jsonl");

  for (let index = 0; index < 21; index += 1) {
    const path = index === 0
      ? oldestPath
      : join(directory, `loop-old-${String(index).padStart(2, "0")}.jsonl`);
    await writeFile(path, `${index}\n`, "utf8");
    const modifiedAt = new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`);
    await utimes(path, modifiedAt, modifiedAt);
  }

  await writeFile(join(directory, ".gitkeep"), "", "utf8");
  await writeFile(join(directory, "other.jsonl"), "keep me\n", "utf8");

  const current = await createRunTraceWriter({
    basePath: join(directory, "loop.jsonl"),
    maxFiles: 20,
    now: () => new Date("2026-07-31T08:30:00.123Z"),
  });
  const names = await readdir(directory);
  const matchingTraces = names.filter(
    (name) => name.startsWith("loop-") && name.endsWith(".jsonl"),
  );

  assert.equal(matchingTraces.length, 20);
  assert.equal(await exists(oldestPath), false);
  assert.equal(await exists(current.tracePath), true);
  assert.equal(await exists(join(directory, ".gitkeep")), true);
  assert.equal(await exists(join(directory, "other.jsonl")), true);
});
