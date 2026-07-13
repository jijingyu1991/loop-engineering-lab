import { realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  createToolError,
  type ToolResult,
} from "./tool-result.js";

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toPortableRelativePath(path: string): string {
  return path ? path.split(sep).join("/") : ".";
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function outsideWorkspace(requestedPath: string) {
  return {
    ok: false as const,
    error: createToolError({
      type: "path_outside_workspace",
      message: "The requested path is outside the configured workspace.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Use a relative path that stays inside the workspace.",
      evidence: {
        path: isAbsolute(requestedPath) ? "<absolute-path>" : requestedPath,
      },
    }),
  };
}

function filesystemFailure(
  error: unknown,
  requestedPath: string,
): ToolResult<never> {
  const code = isNodeError(error) ? error.code : undefined;
  if (code === "ENOENT") {
    return {
      ok: false,
      error: createToolError({
        type: "not_found",
        message: "The requested path does not exist.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Check the relative path and try again.",
        evidence: { path: requestedPath, code },
      }),
    };
  }

  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      error: createToolError({
        type: "permission_denied",
        message: "The path cannot be inspected with the current permissions.",
        retryable: false,
        userActionRequired: true,
        suggestedNextStep: "Grant access inside the workspace, then retry.",
        evidence: { path: requestedPath, code },
      }),
    };
  }

  return {
    ok: false,
    error: createToolError({
      type: "internal_error",
      message: "The workspace path could not be resolved.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Inspect the path and local filesystem state before retrying.",
      evidence: { path: requestedPath, code: code ?? "UNKNOWN" },
    }),
  };
}

async function resolveNewFileTarget(candidate: string): Promise<string> {
  let existingAncestor = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }

      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.push(existingAncestor.slice(parent.length + 1));
      existingAncestor = parent;
    }
  }
}

/**
 * 路径权限以真实文件系统位置为准，而不是仅凭字符串前缀。已有路径直接解析
 * symlink；新文件则解析最近存在父目录后再拼回缺失片段，从而同时阻止 `..`、
 * 绝对路径和“workspace 内 symlink 指向外部目录”三类逃逸。
 */
export async function resolveWorkspacePath(input: {
  workspaceRoot: string;
  requestedPath: string;
  mode: "existing" | "new-file";
}): Promise<ToolResult<ResolvedWorkspacePath>> {
  if (!input.requestedPath.trim()) {
    return {
      ok: false,
      error: createToolError({
        type: "invalid_input",
        message: "Path must not be empty.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Provide a non-empty workspace-relative path.",
        evidence: { path: "<empty>" },
      }),
    };
  }

  if (isAbsolute(input.requestedPath)) {
    return outsideWorkspace(input.requestedPath);
  }

  try {
    const canonicalRoot = await realpath(input.workspaceRoot);
    const lexicalCandidate = resolve(input.workspaceRoot, input.requestedPath);

    // 先做廉价 lexical 检查，再做真实路径检查。前者快速拒绝明显的 `..`，后者
    // 负责 symlink；两层都通过才会把绝对路径交给具体工具。
    if (!isInside(resolve(input.workspaceRoot), lexicalCandidate)) {
      return outsideWorkspace(input.requestedPath);
    }

    const canonicalCandidate =
      input.mode === "existing"
        ? await realpath(lexicalCandidate)
        : await resolveNewFileTarget(lexicalCandidate);

    if (!isInside(canonicalRoot, canonicalCandidate)) {
      return outsideWorkspace(input.requestedPath);
    }

    const relativePath = toPortableRelativePath(
      relative(canonicalRoot, canonicalCandidate),
    );
    return {
      ok: true,
      data: { absolutePath: canonicalCandidate, relativePath },
      evidence: { path: relativePath },
    };
  } catch (error) {
    return filesystemFailure(error, input.requestedPath);
  }
}
