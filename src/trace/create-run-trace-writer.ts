import {
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { JsonlTraceWriter } from "./jsonl-trace-writer.js";

export interface CreateRunTraceWriterOptions {
  basePath: string;
  maxFiles?: number;
  now?: () => Date;
}

interface TraceFile {
  path: string;
  modifiedAt: number;
}

async function pruneTraceFiles(input: {
  directory: string;
  prefix: string;
  extension: string;
  maxFiles: number;
}): Promise<void> {
  const names = await readdir(input.directory);
  const matchingNames = names.filter(
    (name) =>
      name.startsWith(`${input.prefix}-`) && name.endsWith(input.extension),
  );

  const files: TraceFile[] = await Promise.all(
    matchingNames.map(async (name) => {
      const path = join(input.directory, name);
      const metadata = await stat(path);
      return { path, modifiedAt: metadata.mtimeMs };
    }),
  );

  // Newest files come first. Everything after maxFiles is outside the
  // retention window and can be removed without touching unrelated files.
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  await Promise.all(
    files.slice(input.maxFiles).map(async (file) => unlink(file.path)),
  );
}

/**
 * Create one local JSONL file for one Loop run.
 *
 * `basePath` is a naming template rather than the final file name. For
 * `traces/loop.jsonl`, each run gets `traces/loop-<timestamp>.jsonl`. Creating
 * the file before pruning means the current run participates in the same
 * newest-20 rule, including when the process later exits unexpectedly.
 */
export async function createRunTraceWriter(
  options: CreateRunTraceWriterOptions,
): Promise<{ writer: JsonlTraceWriter; tracePath: string }> {
  const maxFiles = options.maxFiles ?? 20;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error("maxFiles must be a positive integer");
  }

  const directory = dirname(options.basePath);
  const extension = extname(options.basePath) || ".jsonl";
  const prefix = basename(options.basePath, extname(options.basePath));
  const timestamp = (options.now?.() ?? new Date())
    .toISOString()
    .replaceAll(":", "-")
    .replace(".", "-");
  const tracePath = join(directory, `${prefix}-${timestamp}${extension}`);

  await mkdir(directory, { recursive: true });
  await writeFile(tracePath, "", { flag: "wx" });
  await pruneTraceFiles({ directory, prefix, extension, maxFiles });

  return { writer: new JsonlTraceWriter(tracePath), tracePath };
}
