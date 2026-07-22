import type { AgentInputItem, FunctionCallResultItem } from "@openai/agents";

import type { ContextCompactionFailureReason } from "../trace/trace-event.js";

/**
 * Context 压缩按逻辑组而不是单条 item 工作。函数调用与其结果必须作为一个组，
 * 否则裁剪后模型可能看到没有证据的调用或无法追溯来源的结果。
 */
export interface ContextItemGroup {
  items: AgentInputItem[];
  callId?: string;
  functionName?: string;
  kind: "message" | "function_tool" | "opaque";
}

/** 保留给 trace 的小型、稳定摘要索引，不复制可能很大的工具原文。 */
export interface ToolSummaryManifest {
  callId: string;
  status: "succeeded" | "failed";
  summaryChars: number;
}

/**
 * 摘要返回替换后的 SDK item 和 trace 所需的元数据。调用方应只把 item 放回模型
 * 输入；manifest 则供后续的 compaction 生命周期事件审计使用。
 */
export interface ToolResultSummary {
  item: FunctionCallResultItem;
  manifest: ToolSummaryManifest;
}

/**
 * 预算压缩不能以损坏工具历史为代价。这个显式错误让上层能 fail-closed，并把原因
 * 写为受控的 trace 枚举值，而不是依赖不稳定的错误字符串分类。
 */
export class ContextBudgetExceededError extends Error {
  public readonly name = "ContextBudgetExceededError";

  public constructor(
    public readonly reason: ContextCompactionFailureReason,
    message: string,
  ) {
    super(message);
  }
}
