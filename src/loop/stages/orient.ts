import type { ObserveData, OrientData } from "../../domain/loop-step.js";
import type { StepOutcome } from "../../domain/step-decision.js";

/**
 * 骨架版 orient 被有意保持简单。阶段外壳中的 `source: skeleton` 标记会明确
 * 数据来源，避免阅读者把这个辅助函数误认为模型生成的分析。
 */
export async function runOrient(
  observation: ObserveData,
): Promise<StepOutcome<OrientData>> {
  return {
    data: {
      objective: observation.task,
      constraints: observation.previousAction
        ? ["Improve on the previous action output."]
        : ["Produce the first useful action output."],
    },
    decision: {
      nextStep: "plan",
      reason: "orientation_completed",
    },
  };
}
