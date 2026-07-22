import { createHash } from "node:crypto";

import type {
  AgentInputItem,
  FunctionCallItem,
  FunctionCallResultItem,
  ModelInputData,
} from "@openai/agents";

import type { WorkflowEvidence } from "../runtime/workflow-types.js";
import type { ContextCompactionFailureReason } from "../trace/trace-event.js";
import {
  type CompactCodingContextInput,
  ContextBudgetExceededError,
  type ContextItemGroup,
  type ToolSummaryManifest,
} from "./context-compaction-types.js";
import {
  groupContextItems,
  measureModelInput,
} from "./context-item-groups.js";
import { summarizeFunctionResult } from "./summarize-tool-result.js";

interface CompactedGroup {
  group: ContextItemGroup;
  summaries: ToolSummaryManifest[];
  protected: boolean;
}

/**
 * Evidence ID 只覆盖可信 evidence 的三个稳定字段。固定属性顺序与截断长度属于 trace
 * 合同的一部分；这样可以核对 evidence 是否延续，而不把可能很长的正文复制到 trace。
 */
export function createPinnedEvidenceId(evidence: WorkflowEvidence): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: evidence.kind,
      source: evidence.source,
      summary: evidence.summary,
    }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * 在每次 SDK 模型调用前执行确定性的字符预算选择。压缩以逻辑组为单位，任何删除或
 * 摘要都不会拆开 function call/result；最近窗口和首组则保持原始对象内容不变。
 */
export async function compactCodingContext(
  input: CompactCodingContextInput,
): Promise<ModelInputData> {
  const { modelData, config, pinnedEvidence, traceWriter, now } = input;
  const instructions = modelData.instructions ?? "";
  const beforeChars = measureModelInput(instructions, modelData.input);

  // 未触及资源边界时返回同一个引用，既避免无意义复制，也不制造 compaction trace 噪声。
  if (beforeChars <= config.maxInputChars) {
    return modelData;
  }

  const groups = groupContextItems(modelData.input);

  await traceWriter.write({
    event: "context_compaction_started",
    timestamp: now(),
    budgetChars: config.maxInputChars,
    beforeChars,
    inputItems: modelData.input.length,
    logicalGroups: groups.length,
  });

  /**
   * 这里只记录算法可预期的预算失败。writer 的 reject 不在 catch 范围内，因而仍以
   * trace 基础设施故障向上传播，绝不会被重新分类为 ContextBudgetExceededError。
   */
  async function failCompaction(
    reason: ContextCompactionFailureReason,
    message: string,
  ): Promise<never> {
    await traceWriter.write({
      event: "context_compaction_failed",
      timestamp: now(),
      budgetChars: config.maxInputChars,
      beforeChars,
      reason,
    });
    throw new ContextBudgetExceededError(reason, message);
  }

  const recentStart = Math.max(0, groups.length - config.keepRecentItems);
  const compactedGroups: CompactedGroup[] = [];

  for (const [index, group] of groups.entries()) {
    const isProtectedOriginal = index === 0 || index >= recentStart;

    if (group.kind !== "function_tool" || isProtectedOriginal) {
      compactedGroups.push({
        group,
        summaries: [],
        protected: isProtectedOriginal,
      });
      continue;
    }

    let summarized: ReturnType<typeof summarizeToolGroup>;
    try {
      summarized = summarizeToolGroup(group, config.maxToolSummaryChars);
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) {
        return failCompaction(error.reason, error.message);
      }

      throw error;
    }

    compactedGroups.push({
      group: summarized.group,
      summaries: summarized.summaries,
      // 失败结论是后续恢复所需证据；即使预算紧张也不能把其所属原子 tool 组删除。
      protected: summarized.summaries.some((item) => item.status === "failed"),
    });
  }

  let retained = compactedGroups;
  let compactedInput = flattenGroups(retained);

  // 摘要后若仍超限，只能从最旧开始删除未保护的普通/opaque 组。tool 组没有安全的
  // 半删除形式，且本策略要求保留其有界摘要，所以永远不进入可删除候选集。
  for (const candidate of compactedGroups) {
    if (measureModelInput(instructions, compactedInput) <= config.maxInputChars) {
      break;
    }

    if (
      candidate.protected ||
      (candidate.group.kind !== "message" && candidate.group.kind !== "opaque")
    ) {
      continue;
    }

    retained = retained.filter((item) => item !== candidate);
    compactedInput = flattenGroups(retained);
  }

  // 对最终序列重新分组会再次执行 orphan/duplicate 校验；预算也必须以真正返回给 SDK
  // 的序列复算，不能依赖中间选择阶段的估计。
  const verifiedGroups = groupContextItems(compactedInput);
  const afterChars = measureModelInput(instructions, compactedInput);

  if (afterChars > config.maxInputChars) {
    return failCompaction(
      "pinned_content_exceeds_budget",
      "Protected coding context exceeds the configured input budget.",
    );
  }

  const summaries = retained.flatMap((item) => item.summaries);
  await traceWriter.write({
    event: "context_compaction_completed",
    timestamp: now(),
    budgetChars: config.maxInputChars,
    beforeChars,
    afterChars,
    retainedGroups: verifiedGroups.length,
    summarizedToolResults: summaries.length,
    pinnedEvidenceIds: pinnedEvidence.map(createPinnedEvidenceId),
    summaries,
  });

  return { ...modelData, input: compactedInput };
}

/**
 * 并发 function calls 会共享一个原子组且结果可能交错出现。这里为每个 result 临时构造
 * 单调用摘要视图，但替换时仍遍历原组 items，因此不会改变 [callA, callB, resultA,
 * resultB] 一类源顺序，也不会把该批次拆成多个可独立删除的组。
 */
function summarizeToolGroup(
  group: ContextItemGroup,
  maxChars: number,
): { group: ContextItemGroup; summaries: ToolSummaryManifest[] } {
  const calls = new Map<string, FunctionCallItem>();
  const summaries: ToolSummaryManifest[] = [];

  for (const item of group.items) {
    if (isFunctionCall(item)) {
      calls.set(item.callId, item);
    }
  }

  const items = group.items.map((item) => {
    if (!isFunctionCallResult(item)) {
      return item;
    }

    const call = calls.get(item.callId);
    if (!call) {
      throw new ContextBudgetExceededError(
        "invalid_tool_history",
        `Missing function call for result ${item.callId}.`,
      );
    }

    const summary = summarizeFunctionResult(
      {
        items: [call, item],
        callId: call.callId,
        functionName: call.name,
        kind: "function_tool",
      },
      maxChars,
    );
    summaries.push(summary.manifest);
    return summary.item;
  });

  return {
    group: { ...group, items },
    summaries,
  };
}

function flattenGroups(groups: CompactedGroup[]): AgentInputItem[] {
  return groups.flatMap((item) => item.group.items);
}

function isFunctionCall(item: AgentInputItem): item is FunctionCallItem {
  return item.type === "function_call";
}

function isFunctionCallResult(
  item: AgentInputItem,
): item is FunctionCallResultItem {
  return item.type === "function_call_result";
}
