import type { AllowedSubagentTool } from "../domain/subagent-contract.js";

/**
 * provider-neutral 的调用输入只传递 Contract 已授权的能力与预算。
 * 具体 SDK 可以把这些字段映射到自己的 Agent API，但不能在这一层补充额外工具。
 */
export interface SubagentInvocationInput {
  prompt: string;
  allowedTools: AllowedSubagentTool[];
  maxSteps: number;
  signal: AbortSignal;
}

export type SubagentInvoker = (input: SubagentInvocationInput) => Promise<unknown>;

export class SubagentMaxStepsExceededError extends Error {
  public constructor() {
    super("Subagent exceeded maxSteps");
    this.name = "SubagentMaxStepsExceededError";
  }
}
