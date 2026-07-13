import type { Agent, Runner } from "@openai/agents";

import type {
  ActData,
  ObserveData,
  PlanData,
} from "../../domain/loop-step.js";

export interface ActInput {
  runner: Runner;
  agent: Agent;
  observation: ObserveData;
  plan: PlanData;
  maxTurns: number;
}

/**
 * 执行当前版本中唯一由模型驱动的阶段。
 *
 * `maxTurns` 限制 Agents SDK 的内部循环（model → tool/handoff → model）；
 * `maxSteps` 则限制外层 loop 最多执行多少次完整的 observe→stop 迭代。两者
 * 有意保持独立，分别约束单次 Agent 调用和整个工程循环。
 */
export async function runAct(input: ActInput): Promise<ActData> {
  const prompt = [
    `Task: ${input.observation.task}`,
    `Previous action: ${input.observation.previousAction ?? "none"}`,
    `Previous reflection: ${input.observation.previousReflection ?? "none"}`,
    `Planned action: ${input.plan.nextAction}`,
  ].join("\n");

  const result = await input.runner.run(input.agent, prompt, {
    maxTurns: input.maxTurns,
  });

  if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
    throw new Error("Agent returned an empty text output");
  }

  return { output: result.finalOutput.trim() };
}
