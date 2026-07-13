import {
  mkdir,
  readdir,
  rm,
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

  // 最新文件排在最前面；位于 `maxFiles` 之后的匹配文件已超出保留窗口，可以
  // 安全删除，同时不会触碰目录中的其他无关文件。
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  await Promise.all(
    files.slice(input.maxFiles).map(async (file) => unlink(file.path)),
  );
}

/**
 * 为每次 Loop 运行创建一个独立的本地 JSONL 文件。
 *
 * `basePath` 是命名模板，而不是最终文件名。例如 `traces/loop.jsonl` 会为
 * 每次运行生成 `traces/loop-<timestamp>.jsonl`。先创建文件再清理，可以让
 * 当前运行也参与相同的“最新 20 个文件”规则，即使进程随后意外退出也一样。
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

  // 旧版本会把每次运行追加到不带时间戳的基础文件中，无法表达“一次运行一个
  // 文件”的保留策略，因此迁移时删除它。`force` 会让该旧文件不存在时的后续
  // 运行安全地成为 no-op。
  await rm(options.basePath, { force: true });
  await writeFile(tracePath, "", { flag: "wx" });
  await pruneTraceFiles({ directory, prefix, extension, maxFiles });

  return { writer: new JsonlTraceWriter(tracePath), tracePath };
}
