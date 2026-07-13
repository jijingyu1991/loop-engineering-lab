import type {
  StepDecision,
  StepType,
} from "../domain/step-decision.js";

/**
 * 当前 LoopStep 不定义重试语义，因此任何回到已执行阶段的决策都属于协议错误。
 * 在真正执行跳转前拒绝它，避免错误决策形成无法受 maxSteps 约束的内部死循环。
 */
export function resolveNextStep(
  decision: StepDecision,
  visitedSteps: ReadonlySet<StepType>,
): StepType {
  if (visitedSteps.has(decision.nextStep)) {
    throw new Error(
      `Step already executed in this LoopStep: ${decision.nextStep}`,
    );
  }

  return decision.nextStep;
}
