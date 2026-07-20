import { spawn } from "node:child_process";
import { sep } from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { TraceInfrastructureError } from "../../trace/trace-infrastructure-error.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import { sanitizeToolText } from "./sanitize-tool-text.js";
import { traceToolExecution } from "./trace-tool-execution.js";
import {
  createToolError,
  type ToolResult,
} from "./tool-result.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";

export interface SearchToolInput {
  pattern: string;
  path: string;
  regex: boolean;
  glob: string | null;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchToolData {
  matches: SearchMatch[];
}

interface RipgrepOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  reason: "closed" | "output_limit" | "match_limit" | "spawn_error";
  observedMatches: number;
  errorCode?: string;
}

function runRipgrep(input: {
  executable: string;
  args: string[];
  cwd: string;
  maxOutputChars: number;
  maxMatches: number;
}): Promise<RipgrepOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let forcedReason: "output_limit" | "match_limit" | null = null;
    let observedMatches = 0;
    let pendingLine = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (outcome: RipgrepOutcome) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(outcome);
    };
    const requestTermination = (reason: "output_limit" | "match_limit") => {
      if (settled || forcedReason) return;
      forcedReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 50);
    };
    const countCompleteMatchLines = (chunk: string) => {
      pendingLine += chunk;
      let newlineIndex = pendingLine.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingLine.slice(0, newlineIndex);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        try {
          if ((JSON.parse(line) as { type?: string }).type === "match") {
            observedMatches += 1;
            if (observedMatches > input.maxMatches) {
              requestTermination("match_limit");
              return;
            }
          }
        } catch {
          // 完整响应仍由 parseMatches 负责校验；流式计数只用于尽早执行资源上限。
        }
        newlineIndex = pendingLine.indexOf("\n");
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (forcedReason) return;
      const remaining = Math.max(
        0,
        input.maxOutputChars - stdout.length - stderr.length,
      );
      stdout += chunk.slice(0, remaining);
      countCompleteMatchLines(chunk.slice(0, remaining));
      if (chunk.length > remaining) requestTermination("output_limit");
    });
    child.stderr?.on("data", (chunk: string) => {
      if (forcedReason) return;
      const remaining = Math.max(
        0,
        input.maxOutputChars - stdout.length - stderr.length,
      );
      stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) requestTermination("output_limit");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        stdout,
        stderr,
        exitCode: null,
        reason: "spawn_error",
        observedMatches,
        errorCode: error.code,
      });
    });
    child.once("close", (exitCode) => {
      finish({
        stdout,
        stderr,
        exitCode,
        reason: forcedReason ?? "closed",
        observedMatches,
      });
    });
  });
}

interface RipgrepMatchMessage {
  type: "match";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: Array<{ start: number }>;
  };
}

function parseMatches(stdout: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const message = JSON.parse(line) as { type?: string };
    if (message.type !== "match") continue;

    const match = message as RipgrepMatchMessage;
    const path = match.data.path.text;
    const text = match.data.lines.text;
    if (path === undefined || text === undefined) continue;

    const portablePath = path.split(sep).join("/");
    matches.push({
      path: portablePath.startsWith("./") ? portablePath.slice(2) : portablePath,
      line: match.data.line_number,
      column: (match.data.submatches[0]?.start ?? 0) + 1,
      text: text.replace(/\r?\n$/, ""),
    });
  }
  return matches;
}

function searchFailure(input: {
  type: "invalid_input" | "dependency_missing" | "process_failed" | "output_limit_exceeded" | "internal_error";
  message: string;
  suggestedNextStep: string;
  evidence: Record<string, string | number | boolean | null | string[]>;
  userActionRequired?: boolean;
}): ToolResult<never> {
  return {
    ok: false,
    error: createToolError({
      type: input.type,
      message: input.message,
      retryable: false,
      userActionRequired: input.userActionRequired ?? false,
      suggestedNextStep: input.suggestedNextStep,
      evidence: { tool: "search", operation: "search", ...input.evidence },
    }),
  };
}

export async function executeSearchTool(
  input: SearchToolInput,
  runtime: ToolRuntimeConfig,
  dependencies: { executable?: string } = {},
): Promise<ToolResult<SearchToolData>> {
  const workspace = await resolveWorkspacePath({
    workspaceRoot: runtime.workspaceRoot,
    requestedPath: ".",
    mode: "existing",
  });
  if (!workspace.ok) return workspace;

  const searchRoot = await resolveWorkspacePath({
    workspaceRoot: runtime.workspaceRoot,
    requestedPath: input.path,
    mode: "existing",
  });
  if (!searchRoot.ok) return searchRoot;

  const args = ["--json", "--sort", "path", "--color", "never"];
  if (!input.regex) args.push("--fixed-strings");
  if (input.glob !== null) args.push("--glob", input.glob);
  // `--` 明确结束 rg 选项解析，避免以 `--pre=...` 等开头的搜索文本变成参数。
  args.push("--", input.pattern, searchRoot.data.relativePath);

  const outcome = await runRipgrep({
    executable: dependencies.executable ?? "rg",
    args,
    cwd: workspace.data.absolutePath,
    maxOutputChars: runtime.search.maxOutputChars,
    maxMatches: runtime.search.maxMatches,
  });
  const boundedStdout = outcome.stdout.slice(0, runtime.search.maxOutputChars);
  const boundedStderr = outcome.stderr.slice(0, runtime.search.maxOutputChars);
  // rg 的语法错误可能在 stderr 中复述搜索词。失败证据会写入 trace，因此既要
  // 清除本次原始 pattern，也要清除环境中已配置的凭据。
  const safeStderr = sanitizeToolText(
    boundedStderr.replaceAll(input.pattern, "[REDACTED]"),
  );

  if (outcome.reason === "spawn_error") {
    const dependencyMissing = outcome.errorCode === "ENOENT";
    return searchFailure({
      type: dependencyMissing ? "dependency_missing" : "internal_error",
      message: dependencyMissing
        ? "ripgrep is not installed or cannot be found."
        : "The search process could not be started.",
      suggestedNextStep: dependencyMissing
        ? "Install ripgrep or correct the configured executable."
        : "Inspect the local process environment before retrying.",
      userActionRequired: dependencyMissing,
      evidence: {
        path: searchRoot.data.relativePath,
        code: outcome.errorCode ?? "UNKNOWN",
      },
    });
  }

  if (outcome.reason === "output_limit") {
    return searchFailure({
      type: "output_limit_exceeded",
      message: "Search output exceeded the configured character limit.",
      suggestedNextStep: "Narrow the path, pattern, or glob before retrying.",
      evidence: {
        path: searchRoot.data.relativePath,
        maxOutputChars: runtime.search.maxOutputChars,
        observedChars: outcome.stdout.length + outcome.stderr.length,
      },
    });
  }

  if (outcome.reason === "match_limit") {
    return searchFailure({
      type: "output_limit_exceeded",
      message: "Search returned more matches than the configured limit.",
      suggestedNextStep: "Narrow the path, pattern, or glob before retrying.",
      evidence: {
        path: searchRoot.data.relativePath,
        observedMatches: outcome.observedMatches,
        maxMatches: runtime.search.maxMatches,
      },
    });
  }

  // ripgrep 使用 1 表示“正常完成但没有匹配”，不能把它误报为进程失败。
  if (outcome.exitCode === 1) {
    return {
      ok: true,
      data: { matches: [] },
      evidence: {
        tool: "search",
        operation: "search",
        path: searchRoot.data.relativePath,
        matches: 0,
      },
    };
  }

  if (outcome.exitCode !== 0) {
    const invalidRegex =
      input.regex &&
      /regex parse error|error parsing regex|unclosed character class/i.test(
        boundedStderr,
      );
    return searchFailure({
      type: invalidRegex ? "invalid_input" : "process_failed",
      message: invalidRegex
        ? "The regular expression is invalid."
        : "ripgrep exited with a nonzero status.",
      suggestedNextStep: invalidRegex
        ? "Correct the regular expression and retry."
        : "Use the exit code and bounded stderr to adjust the search.",
      evidence: {
        path: searchRoot.data.relativePath,
        exitCode: outcome.exitCode,
        stderr: safeStderr,
      },
    });
  }

  try {
    const matches = parseMatches(boundedStdout);
    if (matches.length > runtime.search.maxMatches) {
      return searchFailure({
        type: "output_limit_exceeded",
        message: "Search returned more matches than the configured limit.",
        suggestedNextStep: "Narrow the path, pattern, or glob before retrying.",
        evidence: {
          path: searchRoot.data.relativePath,
          observedMatches: matches.length,
          maxMatches: runtime.search.maxMatches,
        },
      });
    }

    return {
      ok: true,
      data: { matches },
      evidence: {
        tool: "search",
        operation: "search",
        path: searchRoot.data.relativePath,
        matches: matches.length,
      },
    };
  } catch {
    return searchFailure({
      type: "internal_error",
      message: "ripgrep returned an unreadable structured response.",
      suggestedNextStep: "Inspect the local ripgrep version and trace before retrying.",
      evidence: { path: searchRoot.data.relativePath },
    });
  }
}

const searchToolParameters = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).default("."),
  regex: z.boolean().default(false),
  glob: z.string().nullable().default(null),
});

function adapterFailure(): ToolResult<never> {
  return searchFailure({
    type: "invalid_input",
    message: "The search tool arguments failed schema validation.",
    suggestedNextStep: "Correct the search tool arguments to match its schema.",
    evidence: {},
  });
}

export function createSearchTool(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return tool({
    name: "workspace_search",
    description: "Search text with ripgrep inside the configured workspace.",
    parameters: searchToolParameters,
    execute: (input) =>
      traceToolExecution({
        tool: "search",
        operation: "search",
        inputSummary: {
          patternChars: input.pattern.length,
          path: input.path,
          regex: input.regex,
          glob: input.glob,
        },
        traceWriter,
        outcomeRecorder,
        execute: () => executeSearchTool(input, runtime),
      }),
    errorFunction: async (_context, error) => {
      // execute 的 trace 基础设施故障必须穿透 SDK fallback，不能被重新解释成
      // search 参数校验失败；这与业务级工具错误的结构化返回边界不同。
      if (error instanceof TraceInfrastructureError) {
        throw error;
      }
      return JSON.stringify(
        await traceToolExecution({
          tool: "search",
          operation: "adapter",
          inputSummary: { validation: "failed" },
          traceWriter,
          outcomeRecorder,
          execute: async () => adapterFailure(),
        }),
      );
    },
  });
}
