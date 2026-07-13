import type { ReflectData, VerifyData } from "../../domain/loop-step.js";
import type { StepOutcome } from "../../domain/step-decision.js";

export interface ReflectInput {
  actionOutput: string;
  verification: VerifyData;
}

/** 生成下一轮 observe 阶段可以直接消费的最小反馈。 */
export async function runReflect(
  input: ReflectInput,
): Promise<StepOutcome<ReflectData>> {
  return {
    data: {
      summary: input.actionOutput,
      nextFocus: input.verification.passed
        ? null
        : "Use the previous output as context for the next iteration.",
    },
    decision: {
      nextStep: "stop",
      reason: "reflection_completed",
    },
  };
}
