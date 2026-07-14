import { spawn } from "node:child_process";

import { tool } from "@openai/agents";
import { z } from "zod";

import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { resolveWorkspacePath } from "./resolve-workspace-path.js";
import { sanitizeToolText } from "./sanitize-tool-text.js";
import { traceToolExecution } from "./trace-tool-execution.js";
import { resolveShellPermission } from "./tool-permission.js";
import {
  createToolError,
  type ToolResult,
} from "./tool-result.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";

export interface ShellToolInput {
  executable: string;
  args: string[];
  cwd: string;
}

export interface ShellToolData {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  reason: "closed" | "timeout" | "output_limit" | "spawn_error";
  errorCode?: string;
}

function runBoundedProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
}): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let forcedReason: ProcessOutcome["reason"] | null = null;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (outcome: Omit<ProcessOutcome, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        ...outcome,
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    };

    const requestTermination = (
      reason: Extract<ProcessOutcome["reason"], "timeout" | "output_limit">,
    ) => {
      if (settled || forcedReason) return;
      forcedReason = reason;
      child.kill("SIGTERM");
      // 子进程可以捕获并忽略 SIGTERM。短暂宽限后使用 SIGKILL，保证 timeout 与
      // output limit 真正构成宿主级资源上限，而不是仅向子进程发出建议。
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 50);
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
        signal: null,
        reason: "spawn_error",
        errorCode: error.code,
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        stdout,
        stderr,
        exitCode,
        signal,
        reason: forcedReason ?? "closed",
      });
    });

    timeoutTimer = setTimeout(
      () => requestTermination("timeout"),
      input.timeoutMs,
    );
  });
}

function policyFailure(
  type: "command_not_allowed" | "approval_required",
  input: ShellToolInput,
): ToolResult<never> {
  const approvalRequired = type === "approval_required";
  return {
    ok: false,
    error: createToolError({
      type,
      message: approvalRequired
        ? "This command requires user approval before execution."
        : "This command does not match an allowed or approval-required rule.",
      retryable: false,
      userActionRequired: approvalRequired,
      suggestedNextStep: approvalRequired
        ? "Ask the user to approve this exact command in an interactive terminal."
        : "Choose a configured command rule or update the tool configuration.",
      evidence: {
        tool: "shell",
        operation: "execute",
        executable: input.executable,
        argsCount: input.args.length,
        cwd: input.cwd,
      },
    }),
  };
}

function processResult(
  input: ShellToolInput,
  cwd: string,
  maxOutputChars: number,
  outcome: ProcessOutcome,
): ToolResult<ShellToolData> {
  const boundedStdout = outcome.stdout.slice(0, maxOutputChars);
  const boundedStderr = outcome.stderr.slice(0, maxOutputChars);
  const safeStdout = sanitizeToolText(boundedStdout);
  const safeStderr = sanitizeToolText(boundedStderr);
  const commonEvidence = {
    tool: "shell",
    operation: "execute",
    executable: input.executable,
    cwd,
    durationMs: outcome.durationMs,
    stdout: safeStdout,
    stderr: safeStderr,
  };

  if (outcome.reason === "timeout") {
    return {
      ok: false,
      error: createToolError({
        type: "timeout",
        message: "The command exceeded the configured timeout.",
        retryable: true,
        userActionRequired: false,
        suggestedNextStep: "Retry once or narrow the command workload.",
        evidence: commonEvidence,
      }),
    };
  }

  if (outcome.reason === "output_limit") {
    return {
      ok: false,
      error: createToolError({
        type: "output_limit_exceeded",
        message: "The command output exceeded the configured limit.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Narrow the command output or add a more selective argument.",
        evidence: { ...commonEvidence, maxOutputChars },
      }),
    };
  }

  if (outcome.reason === "spawn_error") {
    const dependencyMissing = outcome.errorCode === "ENOENT";
    return {
      ok: false,
      error: createToolError({
        type: dependencyMissing ? "dependency_missing" : "internal_error",
        message: dependencyMissing
          ? "The configured executable is not installed or cannot be found."
          : "The command could not be started.",
        retryable: false,
        userActionRequired: dependencyMissing,
        suggestedNextStep: dependencyMissing
          ? "Install the executable or correct its configured name."
          : "Inspect the executable and local process environment.",
        evidence: {
          ...commonEvidence,
          code: outcome.errorCode ?? "UNKNOWN",
        },
      }),
    };
  }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: createToolError({
        type: "process_failed",
        message: "The command exited with a nonzero status.",
        retryable: false,
        userActionRequired: false,
        suggestedNextStep: "Use the exit code and bounded stdout/stderr to adjust the command.",
        evidence: {
          ...commonEvidence,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
        },
      }),
    };
  }

  return {
    ok: true,
    data: {
      stdout: boundedStdout,
      stderr: boundedStderr,
      exitCode: 0,
    },
    evidence: {
      tool: "shell",
      operation: "execute",
      executable: input.executable,
      cwd,
      durationMs: outcome.durationMs,
      stdoutChars: outcome.stdout.length,
      stderrChars: outcome.stderr.length,
      exitCode: 0,
    },
  };
}

export async function executeShellTool(
  input: ShellToolInput,
  runtime: ToolRuntimeConfig,
  options: { approvalGranted?: boolean } = {},
): Promise<ToolResult<ShellToolData>> {
  const resolvedCwd = await resolveWorkspacePath({
    workspaceRoot: runtime.workspaceRoot,
    requestedPath: input.cwd,
    mode: "existing",
  });
  if (!resolvedCwd.ok) return resolvedCwd;

  const permission = resolveShellPermission(input, runtime.shell);
  if (permission === "denied") return policyFailure("command_not_allowed", input);
  if (permission === "approval_required" && !options.approvalGranted) {
    return policyFailure("approval_required", input);
  }

  const outcome = await runBoundedProcess({
    executable: input.executable,
    args: input.args,
    cwd: resolvedCwd.data.absolutePath,
    timeoutMs: runtime.shell.timeoutMs,
    maxOutputChars: runtime.shell.maxOutputChars,
  });
  return processResult(
    input,
    resolvedCwd.data.relativePath,
    runtime.shell.maxOutputChars,
    outcome,
  );
}

const shellToolParameters = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
});

function adapterFailure(): ToolResult<never> {
  return {
    ok: false,
    error: createToolError({
      type: "invalid_input",
      message: "The shell tool arguments failed schema validation.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Correct the shell tool arguments to match its schema.",
      evidence: { tool: "shell", operation: "adapter" },
    }),
  };
}

export function createShellTool(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
) {
  return tool({
    name: "workspace_shell",
    description: "Execute an argv-based configured command inside the workspace.",
    parameters: shellToolParameters,
    needsApproval: async (_context, input) => {
      // workspace 是不可提升的硬边界。无效 cwd 必须进入结构化拒绝，不能先向用户
      // 展示一个看似可批准、实际越权的请求。
      const cwd = await resolveWorkspacePath({
        workspaceRoot: runtime.workspaceRoot,
        requestedPath: input.cwd,
        mode: "existing",
      });
      return cwd.ok && resolveShellPermission(input, runtime.shell) === "approval_required";
    },
    execute: (input) =>
      traceToolExecution({
        tool: "shell",
        operation: "execute",
        inputSummary: {
          executable: input.executable,
          argsCount: input.args.length,
          cwd: input.cwd,
        },
        traceWriter,
        // SDK 只会在 needsApproval 已获批准后调用 execute；allowed 命令也安全地
        // 通过同一执行路径。denied 与 workspace 越界仍由执行器再次防御。
        execute: () => executeShellTool(input, runtime, { approvalGranted: true }),
      }),
    errorFunction: async () =>
      JSON.stringify(
        await traceToolExecution({
          tool: "shell",
          operation: "adapter",
          inputSummary: { validation: "failed" },
          traceWriter,
          execute: async () => adapterFailure(),
        }),
      ),
  });
}
