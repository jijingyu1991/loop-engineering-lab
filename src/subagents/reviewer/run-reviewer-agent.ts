import { MaxTurnsExceededError, type Runner } from "@openai/agents";

import {
  SubagentMaxStepsExceededError,
  type SubagentInvocationInput,
} from "../subagent-invoker.js";
import type { ReviewerAgent } from "./create-reviewer-agent.js";

/**
 * 将 provider-neutral 的 reviewer 调用合同映射到 Agents SDK Runner。
 *
 * Contract 已在上游声明 reviewer 无工具；这里再次拒绝非空 allowedTools，防止未来
 * 有调用方绕过 Contract 校验后让 SDK 获得与 reviewer 职责不一致的执行能力。
 */
export async function runReviewerAgent(input: SubagentInvocationInput & {
  runner: Runner;
  agent: ReviewerAgent;
}): Promise<unknown> {
  if (input.allowedTools.length > 0) {
    throw new Error("Reviewer contract must not allow tools");
  }

  try {
    // maxSteps 是领域层的统一预算名称，SDK 则用 maxTurns；AbortSignal 必须原样透传，
    // 这样 runSubagent 的 timeout 可以中止底层请求，而不会留下继续消耗资源的调用。
    const result = await input.runner.run(input.agent, input.prompt, {
      maxTurns: input.maxSteps,
      signal: input.signal,
    });

    // reviewer 没有工具，任何 interruption 都说明 SDK 流程越过了角色边界；即使同时
    // 返回 output 也不能接受，避免调用方把未完成或待授权的审查误当作最终结论。
    if (result.interruptions.length > 0) {
      throw new Error("Tool-free reviewer returned an interruption");
    }

    // 不以文本回退：后续 runtime 需要 provider-neutral 的结构化结果继续验证 Contract，
    // 因而缺少 finalOutput 必须显式失败，不能将 undefined 当作合法的 reviewer 结论。
    if (!result.finalOutput) {
      throw new Error("Reviewer returned no structured output");
    }

    return result.finalOutput;
  } catch (error) {
    // SDK 错误类型不应泄漏到 domain/runtime；统一转换后 runSubagent 才能生成稳定、
    // provider-neutral 的 subagent_max_steps_exceeded 结构化失败结果。
    if (error instanceof MaxTurnsExceededError) {
      throw new SubagentMaxStepsExceededError();
    }
    throw error;
  }
}
