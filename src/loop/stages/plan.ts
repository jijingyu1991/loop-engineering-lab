import type { PlanData } from "../../domain/loop-step.js";

export interface PlanInput {
  stepIndex: number;
  objective: string;
}

/**
 * The plan owns the business stop condition. The fixed three-iteration value
 * is learning-project skeleton data, not a safety rule hidden in the runner.
 */
export async function runPlan(input: PlanInput): Promise<PlanData> {
  return {
    nextAction: `Execute iteration ${input.stepIndex} for: ${input.objective}`,
    stopCondition: {
      description: "Complete three iterations of the task.",
    },
  };
}
