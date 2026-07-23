import type {
  AgentInputItem,
  FunctionCallItem,
  FunctionCallResultItem,
} from "@openai/agents";

import type { ToolError } from "../domain/tool-error.js";
import {
  ContextBudgetExceededError,
  type ContextItemGroup,
  type ToolResultSummary,
} from "./context-compaction-types.js";

type ParsedToolEnvelope =
  | { ok: true; data?: unknown; evidence?: unknown }
  | { ok: false; error?: unknown };

interface HeadTailExcerpt {
  head: string;
  tail: string;
  omittedChars: number;
}

/**
 * 只依赖输入文本和保留长度的纯函数。头尾各保留一半能同时展示开始处的命令/路径和
 * 结尾处的结论；中间遗漏量则让模型明确知道这不是完整的工具原文。
 */
export function clipHeadTail(text: string, maxChars: number): HeadTailExcerpt {
  const keptChars = Math.max(0, Math.min(text.length, Math.floor(maxChars)));
  const headChars = Math.ceil(keptChars / 2);
  const tailChars = keptChars - headChars;

  return {
    head: text.slice(0, headChars),
    tail: tailChars === 0 ? "" : text.slice(text.length - tailChars),
    omittedChars: text.length - keptChars,
  };
}

/**
 * 将一个已经过原子分组校验的 function tool 结果缩成确定性 JSON。成功输出可裁剪，
 * 但失败的结构化错误是恢复和安全决策所需的 pinned evidence，绝不能静默丢字段。
 */
export function summarizeFunctionResult(
  group: ContextItemGroup,
  maxChars: number,
): ToolResultSummary {
  const { call, result } = getFunctionToolPair(group);
  const originalOutput = serializeResultOutput(result.output);
  const parsed = parseToolEnvelope(originalOutput);

  if (
    result.status === "completed" &&
    parsed?.ok === false &&
    isToolError(parsed.error)
  ) {
    const output = JSON.stringify({
      ok: false,
      compacted: true,
      callId: call.callId,
      tool: call.name,
      error: {
        type: parsed.error.type,
        message: parsed.error.message,
        retryable: parsed.error.retryable,
        userActionRequired: parsed.error.userActionRequired,
        suggestedNextStep: parsed.error.suggestedNextStep,
        evidence: parsed.error.evidence,
      },
      conclusion: "attempt_failed",
    });

    ensureFitsBudget(output, maxChars);
    return createSummary(result, output, "failed");
  }

  // SDK status 是工具执行是否完成的第一事实来源；显式 ok:false 则是工具协议的
  // 第一事实来源。二者任一声明失败/未完成时，即使其余字段残缺，也只能生成有界的
  // unknown-failure 摘要，绝不能回退到成功分支并制造“已成功”的审计事实。
  if (result.status !== "completed" || parsed?.ok === false) {
    const sourceFormat = result.status !== "completed"
      ? "function_result_status"
      : "malformed_tool_error_envelope";
    const output = fitUnknownFailureSummary(
      call,
      result,
      originalOutput,
      sourceFormat,
      maxChars,
    );

    return createSummary(result, output, "failed");
  }

  // 只有协议完全匹配时才抽取 data；任意其他 JSON 都是工具的原始成功文本，避免把
  // 第三方输出误判为本项目的错误协议而遗失信息。
  const sourceFormat = parsed ? "tool_data" : "raw_output";
  const sourceText = parsed
    ? JSON.stringify(parsed.data) ?? ""
    : originalOutput;
  const output = fitSuccessfulSummary(
    call,
    originalOutput.length,
    sourceFormat,
    sourceText,
    maxChars,
  );

  return createSummary(result, output, "succeeded");
}

function fitSuccessfulSummary(
  call: FunctionCallItem,
  originalChars: number,
  sourceFormat: string,
  sourceText: string,
  maxChars: number,
): string {
  const operation = resolveToolOperation(call);
  const buildOutput = (excerpt: HeadTailExcerpt) =>
    JSON.stringify({
      ok: true,
      compacted: true,
      callId: call.callId,
      tool: call.name,
      ...(operation ? { operation } : {}),
      originalChars,
      // 该字段只描述被摘要文本的格式，不声称文件、命令或 trace provenance。
      sourceFormat,
      excerpt: {
        head: excerpt.head,
        tail: excerpt.tail,
        omittedChars: excerpt.omittedChars,
      },
    });

  const emptyOutput = buildOutput(clipHeadTail(sourceText, 0));
  ensureFitsBudget(emptyOutput, maxChars);

  // JSON 转义会让“字符数”和“序列化后的字符数”不同，因此依据最终 JSON 长度二分
  // 搜索可保留内容，而不是粗略从 maxChars 中扣除固定常数。
  let lower = 0;
  let upper = sourceText.length;
  let best = emptyOutput;

  while (lower <= upper) {
    const candidateChars = Math.floor((lower + upper) / 2);
    const candidate = buildOutput(clipHeadTail(sourceText, candidateChars));

    if (candidate.length <= maxChars) {
      best = candidate;
      lower = candidateChars + 1;
    } else {
      upper = candidateChars - 1;
    }
  }

  return best;
}

/**
 * operation 只在 Coding 工具名本身具有封闭语义时写入。未知第三方
 * 工具不解析任意参数来猜测 operation，避免制造虚假的 provenance。
 */
function resolveToolOperation(call: FunctionCallItem): string | undefined {
  const knownCodingOperations: Readonly<Record<string, string>> = {
    workspace_file_read: "read",
    workspace_search: "search",
    workspace_shell: "execute",
  };
  return knownCodingOperations[call.name];
}

function fitUnknownFailureSummary(
  call: FunctionCallItem,
  result: FunctionCallResultItem,
  originalOutput: string,
  sourceFormat: string,
  maxChars: number,
): string {
  const buildOutput = (excerpt: HeadTailExcerpt) =>
    JSON.stringify({
      ok: false,
      compacted: true,
      callId: call.callId,
      tool: call.name,
      resultStatus: result.status ?? "unknown",
      originalChars: originalOutput.length,
      sourceFormat,
      excerpt: {
        head: excerpt.head,
        tail: excerpt.tail,
        omittedChars: excerpt.omittedChars,
      },
      conclusion: "attempt_failed",
    });

  const emptyOutput = buildOutput(clipHeadTail(originalOutput, 0));
  ensureFitsBudget(emptyOutput, maxChars);

  let lower = 0;
  let upper = originalOutput.length;
  let best = emptyOutput;

  while (lower <= upper) {
    const candidateChars = Math.floor((lower + upper) / 2);
    const candidate = buildOutput(clipHeadTail(originalOutput, candidateChars));

    if (candidate.length <= maxChars) {
      best = candidate;
      lower = candidateChars + 1;
    } else {
      upper = candidateChars - 1;
    }
  }

  return best;
}

function createSummary(
  result: FunctionCallResultItem,
  output: string,
  status: "succeeded" | "failed",
): ToolResultSummary {
  return {
    item: { ...result, output },
    manifest: {
      callId: result.callId,
      status,
      summaryChars: output.length,
    },
  };
}

function getFunctionToolPair(group: ContextItemGroup): {
  call: FunctionCallItem;
  result: FunctionCallResultItem;
} {
  const [first, second, ...rest] = group.items;

  if (
    group.kind !== "function_tool" ||
    rest.length !== 0 ||
    !first ||
    !second ||
    !isFunctionCall(first) ||
    !isFunctionCallResult(second) ||
    first.callId !== second.callId
  ) {
    throw new ContextBudgetExceededError(
      "invalid_tool_history",
      "Tool result summaries require one matching function call and result.",
    );
  }

  return { call: first, result: second };
}

function parseToolEnvelope(output: string): ParsedToolEnvelope | undefined {
  let value: unknown;

  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return undefined;
  }

  if (value.ok === true) {
    return { ok: true, data: value.data, evidence: value.evidence };
  }

  // 一旦工具明确给出 ok:false，就保留这个失败判定；error 是否完整由调用方决定
  // 使用完整失败合同还是保守 unknown-failure 摘要，不能把残缺 error 当作成功原文。
  return { ok: false, error: value.error };
}

function isToolError(value: unknown): value is ToolError {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.userActionRequired === "boolean" &&
    typeof value.suggestedNextStep === "string" &&
    isRecord(value.evidence)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeResultOutput(output: FunctionCallResultItem["output"]): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function ensureFitsBudget(output: string, maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars <= 0 || output.length > maxChars) {
    throw new ContextBudgetExceededError(
      "pinned_content_exceeds_budget",
      "Pinned tool result content exceeds the context summary budget.",
    );
  }
}

function isFunctionCall(item: AgentInputItem): item is FunctionCallItem {
  return item.type === "function_call";
}

function isFunctionCallResult(item: AgentInputItem): item is FunctionCallResultItem {
  return item.type === "function_call_result";
}
