import {
  ToolCallError,
  type RunToolApprovalItem,
  type Runner,
} from "@openai/agents";

import { sanitizeToolText } from "../../agents/tools/sanitize-tool-text.js";
import type { ContextCompactionConfig } from "../../config/config-schema.js";
import { compactCodingContext } from "../../context/compact-coding-context.js";
import { ContextBudgetExceededError } from "../../context/context-compaction-types.js";
import type { WorkflowEvidence } from "../../runtime/workflow-types.js";
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { TraceInfrastructureError } from "../../trace/trace-infrastructure-error.js";
import type { CodingExecutorResult } from "./coding-state.js";
import type { CodingAgent } from "./create-coding-agent.js";

function parseShellApproval(item: RunToolApprovalItem): {
  toolCallId: string;
  executable: string;
  args: string[];
  cwd: string;
} {
  if (item.name !== "workspace_shell" || item.rawItem.type !== "function_call") {
    throw new Error("Only local shell tool approvals are supported in coding mode");
  }

  const parsed = JSON.parse(item.arguments ?? "null") as {
    executable?: unknown;
    args?: unknown;
    cwd?: unknown;
  } | null;
  if (
    !parsed ||
    typeof parsed.executable !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((value) => typeof value === "string") ||
    typeof parsed.cwd !== "string"
  ) {
    throw new Error("Coding shell approval request has invalid arguments");
  }

  return {
    toolCallId: item.rawItem.callId,
    executable: parsed.executable,
    args: parsed.args,
    cwd: parsed.cwd,
  };
}

export async function runCodingAgent(input: {
  runner: Runner;
  agent: CodingAgent;
  prompt: string;
  maxTurns: number;
  contextCompaction: ContextCompactionConfig;
  pinnedEvidence: WorkflowEvidence[];
  traceWriter: TraceWriter;
  now?: () => string;
  /** Server-managed history bypasses the full local history this compactor must inspect. */
  conversationId?: never;
  previousResponseId?: never;
}): Promise<CodingExecutorResult> {
  const historyOptions = input as {
    conversationId?: unknown;
    previousResponseId?: unknown;
  };
  if (
    historyOptions.conversationId !== undefined ||
    historyOptions.previousResponseId !== undefined
  ) {
    throw new Error(
      "Server-managed conversationId/previousResponseId history is unsupported by coding context compaction.",
    );
  }

  const now = input.now ?? (() => new Date().toISOString());
  let result;
  try {
    result = await input.runner.run(input.agent, input.prompt, {
      maxTurns: input.maxTurns,
      // SDK 会在每一轮模型调用前执行该 hook，包括工具产生新历史后的后续轮次；
      // 因此预算约束覆盖整次 Coding Agent run，而不是只检查初始 prompt。
      callModelInputFilter: ({ modelData }) => compactCodingContext({
        modelData,
        config: input.contextCompaction,
        pinnedEvidence: input.pinnedEvidence,
        traceWriter: input.traceWriter,
        now,
      }),
    });
  } catch (error: unknown) {
    // 只有 compactor 明确声明的不可满足预算才转成业务终态。trace writer、SDK
    // 以及普通工具错误继续 reject，避免用“预算不足”掩盖审计链或 provider 故障。
    if (error instanceof ContextBudgetExceededError) {
      return {
        type: "stopped",
        status: "failed",
        reason: "context_budget_exceeded",
      };
    }
    // Agents SDK 会把 function tool 的原始异常包进 ToolCallError.error。只在这个
    // 精确组合下恢复同一个 trace 基础设施错误，让 provider-neutral workflow 能按
    // 既有边界识别；其他 SDK/工具异常必须保留 wrapper、state 与诊断语义。
    if (
      error instanceof ToolCallError &&
      error.error instanceof TraceInfrastructureError
    ) {
      throw error.error;
    }
    throw error;
  }

  // 中断比 finalOutput 缺失更具体；当前里程碑不保存或恢复 SDK RunState，
  // 因此把任何工具审批中断稳定映射成上层可理解的 blocked 终态。
  if (result.interruptions.length > 0) {
    for (const interruption of result.interruptions) {
      const approval = parseShellApproval(interruption);
      // 参数需要足以重建待批命令，但 trace 不能持久化 token、key 等配置凭据。
      // 逐字段清洗而非清洗 JSON 字符串，能保留稳定的结构供后续审计使用。
      await input.traceWriter.write({
        event: "tool_approval_requested",
        timestamp: now(),
        tool: "shell",
        toolCallId: approval.toolCallId,
        input: {
          executable: sanitizeToolText(approval.executable),
          arguments: approval.args.map((argument) => sanitizeToolText(argument)),
          argsCount: approval.args.length,
          cwd: sanitizeToolText(approval.cwd),
        },
      });
    }
    return {
      type: "stopped",
      status: "blocked",
      reason: "approval_required",
    };
  }

  if (!result.finalOutput) {
    return {
      type: "stopped",
      status: "failed",
      reason: "runtime_error",
    };
  }

  return {
    type: "completed",
    output: result.finalOutput.output,
    evidence: result.finalOutput.evidence,
  };
}
