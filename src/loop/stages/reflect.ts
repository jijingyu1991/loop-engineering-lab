import type { ReflectData, VerifyData } from "../../domain/loop-step.js";

export interface ReflectInput {
  actionOutput: string;
  verification: VerifyData;
}

/** 生成下一轮 observe 阶段可以直接消费的最小反馈。 */
export async function runReflect(input: ReflectInput): Promise<ReflectData> {
  return {
    summary: input.actionOutput,
    nextFocus: input.verification.passed
      ? null
      : "Use the previous output as context for the next iteration.",
  };
}
