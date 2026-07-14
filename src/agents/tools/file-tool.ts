import { randomUUID } from "node:crypto";
import {
  link,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import { traceToolExecution } from "./trace-tool-execution.js";
import {
  createToolError,
  type ToolResult,
} from "./tool-result.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";

export type FileToolInput =
  | { action: "read"; path: string }
  | {
      action: "write";
      path: string;
      content: string;
      overwrite: boolean;
    };

export interface FileReadData {
  content: string;
  chars: number;
  bytes: number;
}

export interface FileWriteData {
  path: string;
  bytes: number;
  overwritten: boolean;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function fileFailure(
  error: unknown,
  operation: FileToolInput["action"],
  path: string,
): ToolResult<never> {
  const code = isNodeError(error) ? error.code : undefined;

  if (code === "EEXIST") {
    return {
      ok: false,
      error: createToolError({
        type: "conflict",
        message: "The target file already exists.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Retry with overwrite set to true only if replacement is intended.",
        evidence: { tool: "file", operation, path, code },
      }),
    };
  }

  if (code === "ENOENT") {
    return {
      ok: false,
      error: createToolError({
        type: "not_found",
        message: operation === "read"
          ? "The requested file does not exist."
          : "The target parent directory does not exist.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Check the workspace-relative path and its parent directory.",
        evidence: { tool: "file", operation, path, code },
      }),
    };
  }

  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      error: createToolError({
        type: "permission_denied",
        message: "The file operation is not permitted.",
        retryable: false,
        userActionRequired: true,
        suggestedNextStep: "Grant the required workspace file permission, then retry.",
        evidence: { tool: "file", operation, path, code },
      }),
    };
  }

  if (code === "EISDIR" || code === "ENOTDIR") {
    return {
      ok: false,
      error: createToolError({
        type: "invalid_input",
        message: "The requested path is not a regular file target.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Provide a workspace-relative regular file path.",
        evidence: { tool: "file", operation, path, code },
      }),
    };
  }

  return {
    ok: false,
    error: createToolError({
      type: "internal_error",
      message: "The file operation failed unexpectedly.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Inspect the local filesystem state before retrying.",
      evidence: {
        tool: "file",
        operation,
        path,
        code: code ?? "UNKNOWN",
      },
    }),
  };
}

async function readWorkspaceFile(
  input: Extract<FileToolInput, { action: "read" }>,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileReadData>> {
  const resolved = await resolveWorkspacePath({
    workspaceRoot: runtime.workspaceRoot,
    requestedPath: input.path,
    mode: "existing",
  });
  if (!resolved.ok) return resolved;

  try {
    const buffer = await readFile(resolved.data.absolutePath);
    const content = buffer.toString("utf8");
    if (content.length > runtime.file.maxReadChars) {
      return {
        ok: false,
        error: createToolError({
          type: "output_limit_exceeded",
          message: "The file is larger than the configured read limit.",
          retryable: false,
          userActionRequired: false,
          suggestedNextStep: "Use the search tool to retrieve a narrower section.",
          evidence: {
            tool: "file",
            operation: "read",
            path: resolved.data.relativePath,
            chars: content.length,
            maxReadChars: runtime.file.maxReadChars,
          },
        }),
      };
    }

    const evidence = {
      tool: "file",
      operation: "read",
      path: resolved.data.relativePath,
      chars: content.length,
      bytes: buffer.byteLength,
    };
    return {
      ok: true,
      data: { content, chars: content.length, bytes: buffer.byteLength },
      evidence,
    };
  } catch (error) {
    return fileFailure(error, "read", resolved.data.relativePath);
  }
}

async function writeWorkspaceFile(
  input: Extract<FileToolInput, { action: "write" }>,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileWriteData>> {
  const resolved = await resolveWorkspacePath({
    workspaceRoot: runtime.workspaceRoot,
    requestedPath: input.path,
    mode: "new-file",
  });
  if (!resolved.ok) return resolved;

  const target = resolved.data.absolutePath;
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.byteLength(input.content, "utf8");

  try {
    await writeFile(temporary, input.content, { encoding: "utf8", flag: "wx" });

    if (input.overwrite) {
      // rename 在同一目录中是原子的；读者只会看到旧内容或完整新内容。
      await rename(temporary, target);
    } else {
      // hard link 带有原子的 EEXIST 语义，避免先检查目标再 rename 产生 TOCTOU 覆盖。
      await link(temporary, target);
      await unlink(temporary);
    }

    const evidence = {
      tool: "file",
      operation: "write",
      path: resolved.data.relativePath,
      bytes,
      overwritten: input.overwrite,
    };
    return {
      ok: true,
      data: {
        path: resolved.data.relativePath,
        bytes,
        overwritten: input.overwrite,
      },
      evidence,
    };
  } catch (error) {
    return fileFailure(error, "write", resolved.data.relativePath);
  } finally {
    // 只清理本次调用使用随机名称创建的临时文件，绝不触碰调用方目标。
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function executeFileTool(
  input: Extract<FileToolInput, { action: "read" }>,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileReadData>>;
export function executeFileTool(
  input: Extract<FileToolInput, { action: "write" }>,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileWriteData>>;
export function executeFileTool(
  input: FileToolInput,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileReadData | FileWriteData>>;
export async function executeFileTool(
  input: FileToolInput,
  runtime: ToolRuntimeConfig,
): Promise<ToolResult<FileReadData | FileWriteData>> {
  return input.action === "read"
    ? readWorkspaceFile(input, runtime)
    : writeWorkspaceFile(input, runtime);
}

const fileToolParameters = z.object({
  action: z.enum(["read", "write"]),
  path: z.string().min(1),
  content: z.string().nullable().default(null),
  overwrite: z.boolean().default(false),
});

function adapterFailure(): ToolResult<never> {
  return {
    ok: false,
    error: createToolError({
      type: "invalid_input",
      message: "The file tool arguments failed schema validation.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Correct the file tool arguments to match its schema.",
      evidence: { tool: "file", operation: "adapter" },
    }),
  };
}

export function createFileTool(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return tool({
    name: "workspace_file",
    description: "Read or atomically write a UTF-8 file inside the configured workspace.",
    parameters: fileToolParameters,
    execute: (input) =>
      traceToolExecution({
        tool: "file",
        operation: input.action,
        inputSummary: { path: input.path, overwrite: input.overwrite },
        traceWriter,
        outcomeRecorder,
        execute: () => {
          if (input.action === "write" && input.content === null) {
            return Promise.resolve({
              ok: false as const,
              error: createToolError({
                type: "invalid_input",
                message: "Write action requires content.",
                retryable: false,
                userActionRequired: false,
                suggestedNextStep: "Provide string content for the write action.",
                evidence: {
                  tool: "file",
                  operation: "write",
                  path: input.path,
                },
              }),
            });
          }

          const fileInput: FileToolInput = input.action === "read"
            ? { action: "read", path: input.path }
            : {
                action: "write",
                path: input.path,
                content: input.content ?? "",
                overwrite: input.overwrite,
              };
          return executeFileTool(fileInput, runtime);
        },
      }),
    errorFunction: async () =>
      JSON.stringify(
        await traceToolExecution({
          tool: "file",
          operation: "adapter",
          inputSummary: { validation: "failed" },
          traceWriter,
          outcomeRecorder,
          execute: async () => adapterFailure(),
        }),
      ),
  });
}
