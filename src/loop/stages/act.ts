import type { RunToolApprovalItem, Runner } from "@openai/agents";

import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
} from "../../agents/terminal-approval-handler.js";
import type { ActorAgent } from "../../agents/create-agent.js";
import type { ToolOutcomeRecorder } from "../../agents/tools/tool-outcome-recorder.js";
import { createToolError } from "../../agents/tools/tool-result.js";
import type {
  ActData,
  ObserveData,
  PlanData,
} from "../../domain/loop-step.js";
import type { StepOutcome } from "../../domain/step-decision.js";
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";

export interface ActInput {
  runner: Runner;
  agent: ActorAgent;
  observation: ObserveData;
  plan: PlanData;
  maxTurns: number;
  traceWriter?: TraceWriter;
  approvalHandler?: ApprovalHandler;
  outcomeRecorder: ToolOutcomeRecorder;
  now?: () => string;
}

function parseApprovalRequest(item: RunToolApprovalItem): {
  request: ApprovalRequest;
  toolCallId: string;
} {
  if (item.rawItem.type !== "function_call") {
    throw new Error("Only local function tool approvals are supported");
  }

  const parsed = JSON.parse(item.arguments ?? "null") as Partial<ApprovalRequest> | null;
  if (
    !parsed ||
    typeof parsed.executable !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((value) => typeof value === "string") ||
    typeof parsed.cwd !== "string"
  ) {
    throw new Error("Shell approval request has invalid arguments");
  }

  return {
    request: {
      executable: parsed.executable,
      args: parsed.args,
      cwd: parsed.cwd,
    },
    toolCallId: item.rawItem.callId,
  };
}

function approvalFailure(
  decision: Exclude<ApprovalDecision, "approved">,
  request: ApprovalRequest,
) {
  const unavailable = decision === "unavailable";
  return createToolError({
    type: unavailable ? "approval_required" : "approval_rejected",
    message: unavailable
      ? "User approval is required, but no interactive terminal is available."
      : "The user rejected this shell command.",
    retryable: false,
    userActionRequired: unavailable,
    suggestedNextStep: unavailable
      ? "Rerun in an interactive terminal and approve the exact command if appropriate."
      : "Choose a safer allowed command or continue without this operation.",
    evidence: {
      tool: "shell",
      operation: "execute",
      executable: request.executable,
      argsCount: request.args.length,
      cwd: request.cwd,
    },
  });
}

/**
 * 执行当前版本中唯一由模型驱动的阶段。
 *
 * `maxTurns` 限制 Agents SDK 的内部循环（model → tool/handoff → model）；
 * `maxSteps` 则限制外层 loop 最多执行多少次完整的 observe→stop 迭代。两者
 * 有意保持独立，分别约束单次 Agent 调用和整个工程循环。
 */
export async function runAct(input: ActInput): Promise<StepOutcome<ActData>> {
  const prompt = [
    `Task: ${input.observation.task}`,
    `Previous action: ${input.observation.previousAction ?? "none"}`,
    `Previous reflection: ${input.observation.previousReflection ?? "none"}`,
    `Planned action: ${input.plan.nextAction}`,
  ].join("\n");

  const traceWriter = input.traceWriter ?? { write: async () => undefined };
  const approvalHandler = input.approvalHandler ?? (async () => "unavailable" as const);
  const now = input.now ?? (() => new Date().toISOString());
  const toolCheckpoint = input.outcomeRecorder.checkpoint();
  let result = await input.runner.run(input.agent, prompt, {
    maxTurns: input.maxTurns,
  });

  while (result.interruptions.length > 0) {
    for (const interruption of result.interruptions) {
      const { request, toolCallId } = parseApprovalRequest(interruption);
      await traceWriter.write({
        event: "tool_approval_requested",
        timestamp: now(),
        tool: "shell",
        toolCallId,
        input: {
          executable: request.executable,
          argsCount: request.args.length,
          cwd: request.cwd,
        },
      });

      const decision = await approvalHandler(request);
      await traceWriter.write({
        event: "tool_approval_resolved",
        timestamp: now(),
        tool: "shell",
        toolCallId,
        approved: decision === "approved",
        decision,
      });

      if (decision === "approved") {
        result.state.approve(interruption);
      } else {
        const error = approvalFailure(decision, request);
        input.outcomeRecorder.recordFailure(error);
        result.state.reject(interruption, {
          message: JSON.stringify({ ok: false, error }),
        });
        // 被拒绝的工具不会进入 execute wrapper，因此协调层补写 tool_failed，确保
        // Agent 所见 JSON 与 retry 审计依据仍来自同一个 ToolError。
        await traceWriter.write({
          event: "tool_failed",
          timestamp: now(),
          tool: "shell",
          operation: "execute",
          durationMs: 0,
          error,
        });
      }
    }

    // SDK 要求批准/拒绝后用同一 RunState 恢复；重新提交 prompt 会丢失 pending
    // tool call，并可能让模型重复产生副作用。
    result = await input.runner.run(input.agent, result.state, {
      maxTurns: input.maxTurns,
    });
  }

  if (!result.finalOutput) {
    throw new Error("Agent returned no structured output");
  }

  const terminal =
    result.finalOutput.outcome === "failed" ||
    result.finalOutput.outcome === "blocked" ||
    result.finalOutput.outcome === "cancelled";

  return {
    data: {
      output: result.finalOutput.output,
      outcome: result.finalOutput.outcome,
      toolErrors: input.outcomeRecorder.failuresSince(toolCheckpoint),
    },
    decision: {
      nextStep: terminal ? "stop" : "verify",
      reason: terminal ? "action_terminal" : "action_completed",
    },
  };
}
