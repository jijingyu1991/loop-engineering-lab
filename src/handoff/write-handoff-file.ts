import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface HandoffFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

const nodeFileSystem: HandoffFileSystem = {
  mkdir,
  writeFile,
  rename,
  rm,
};

export async function writeHandoffFile(input: {
  handoffPath: string;
  markdown: string;
  fileSystem?: HandoffFileSystem;
  createId?: () => string;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const directory = dirname(input.handoffPath);
  const temporaryPath = join(
    directory,
    `.${basename(input.handoffPath)}.${(input.createId ?? randomUUID)()}.tmp`,
  );

  try {
    await fileSystem.mkdir(directory, { recursive: true });
    // wx 防止罕见的临时名碰撞覆盖其他进程文件；只有完整写入成功后才允许 rename，
    // 因而读者永远不会在 handoff.md 看到半份 Markdown。
    await fileSystem.writeFile(temporaryPath, input.markdown, {
      encoding: "utf8",
      flag: "wx",
    });
    await fileSystem.rename(temporaryPath, input.handoffPath);
  } catch (cause) {
    // cleanup 是 best effort：它不能遮蔽真正的 write/rename 故障。rename 之前失败时，
    // 目标路径从未被修改，所以旧 handoff 仍是完整且可恢复的交接点。
    try {
      await fileSystem.rm(temporaryPath, { force: true });
    } catch {
      // 原始失败包含对调用方更有价值的原因，临时文件清理失败不取代它。
    }
    throw new Error(
      `Failed to write handoff artifact: ${input.handoffPath}`,
      { cause },
    );
  }
}
