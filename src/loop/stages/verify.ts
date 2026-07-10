import type { PlanData, VerifyData } from "../../domain/loop-step.js";

export interface VerifyInput {
  stepIndex: number;
  plan: PlanData;
  actionOutput: string;
}

/**
 * This is a transparent skeleton verifier, not an independent reviewer Agent.
 * Its narrow contract is the seam where a real reviewer can be introduced.
 */
export async function runVerify(input: VerifyInput): Promise<VerifyData> {
  const passed = input.stepIndex >= 3;
  return {
    passed,
    evidence: passed
      ? `Iteration ${input.stepIndex} satisfies: ${input.plan.stopCondition.description}`
      : `Iteration ${input.stepIndex} has not yet satisfied: ${input.plan.stopCondition.description}`,
  };
}
