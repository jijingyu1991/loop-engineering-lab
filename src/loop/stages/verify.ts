import type { PlanData, VerifyData } from "../../domain/loop-step.js";
import type { StepOutcome } from "../../domain/step-decision.js";

export interface VerifyInput {
  stepIndex: number;
  plan: PlanData;
  actionOutput: string;
}

/**
 * 这是行为透明的骨架 verifier，并不是独立的 reviewer Agent。它保持窄接口，
 * 以后可以沿着这个边界接入真正的 reviewer，而不影响其他阶段。
 */
export async function runVerify(
  input: VerifyInput,
): Promise<StepOutcome<VerifyData>> {
  const passed = input.stepIndex >= 3;
  return {
    data: {
      passed,
      evidence: passed
        ? `Iteration ${input.stepIndex} satisfies: ${input.plan.stopCondition.description}`
        : `Iteration ${input.stepIndex} has not yet satisfied: ${input.plan.stopCondition.description}`,
    },
    decision: {
      nextStep: "reflect",
      reason: "verification_completed",
    },
  };
}
