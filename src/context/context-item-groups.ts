import type { AgentInputItem, FunctionCallItem, FunctionCallResultItem } from "@openai/agents";

import {
  ContextBudgetExceededError,
  type ContextItemGroup,
} from "./context-compaction-types.js";

/**
 * 这里刻意不估算 token：同一套 compaction 逻辑需要对 provider 保持中立，并且预算
 * 决策必须可重现。JSON.stringify 的属性插入顺序由调用方输入保持，因此该值可以被
 * trace 和测试稳定复算。
 */
export function measureModelInput(
  instructions: string,
  input: AgentInputItem[],
): number {
  return JSON.stringify({ instructions, input }).length;
}

/**
 * 将函数调用和对应结果恢复为不可分割的逻辑单元。先完整校验所有 callId，再创建
 * groups，能防止在发现孤儿结果前已经返回半截历史，从而保证调用方只能得到完整结果。
 */
export function groupContextItems(input: AgentInputItem[]): ContextItemGroup[] {
  const calls = new Map<string, IndexedItem<FunctionCallItem>>();
  const results = new Map<string, IndexedItem<FunctionCallResultItem>>();

  for (const [index, item] of input.entries()) {
    if (isFunctionCall(item)) {
      if (calls.has(item.callId)) {
        throw invalidToolHistory(`Duplicate function call for callId ${item.callId}.`);
      }

      calls.set(item.callId, { index, item });
    }

    if (isFunctionCallResult(item)) {
      if (results.has(item.callId)) {
        throw invalidToolHistory(`Duplicate function result for callId ${item.callId}.`);
      }

      results.set(item.callId, { index, item });
    }
  }

  for (const [callId, call] of calls) {
    const result = results.get(callId);
    if (!result) {
      throw invalidToolHistory(`Orphan function call for callId ${callId}.`);
    }

    if (result.index < call.index) {
      throw invalidToolHistory(`Orphan function result for callId ${callId}.`);
    }
  }

  for (const [callId] of results) {
    if (!calls.has(callId)) {
      throw invalidToolHistory(`Orphan function result for callId ${callId}.`);
    }
  }

  const groups: ContextItemGroup[] = [];
  const groupedResults = new Set<string>();

  for (const item of input) {
    if (isFunctionCall(item)) {
      const indexedResult = results.get(item.callId);
      if (!indexedResult) {
        throw invalidToolHistory(`Orphan function call for callId ${item.callId}.`);
      }

      groups.push({
        items: [item, indexedResult.item],
        callId: item.callId,
        functionName: item.name,
        kind: "function_tool",
      });
      groupedResults.add(item.callId);
      continue;
    }

    if (isFunctionCallResult(item) && groupedResults.has(item.callId)) {
      continue;
    }

    groups.push({
      items: [item],
      kind: isMessageItem(item) ? "message" : "opaque",
    });
  }

  return groups;
}

interface IndexedItem<T> {
  index: number;
  item: T;
}

function isFunctionCall(item: AgentInputItem): item is FunctionCallItem {
  return item.type === "function_call";
}

function isFunctionCallResult(item: AgentInputItem): item is FunctionCallResultItem {
  return item.type === "function_call_result";
}

function isMessageItem(item: AgentInputItem): boolean {
  return "role" in item;
}

function invalidToolHistory(message: string): ContextBudgetExceededError {
  return new ContextBudgetExceededError("invalid_tool_history", message);
}
