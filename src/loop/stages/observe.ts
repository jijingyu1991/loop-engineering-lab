import type { LoopStep, ObserveData } from "../../domain/loop-step.js";
import type { StepOutcome } from "../../domain/step-decision.js";

export interface ObserveInput {
  task: string;
  previousStep?: LoopStep;
}

/** 从持久化的 loop 状态中构造下一轮迭代所需的上下文。 */
export function runObserve(input: ObserveInput): StepOutcome<ObserveData> {
  return {
    data: {
      task: input.task,
      previousAction: input.previousStep?.act.data?.output ?? null,
      previousReflection: input.previousStep?.reflect.data?.summary ?? null,
    },
    // 当前路径仍保持原有默认顺序，但顺序的所有权已从协调器移到阶段本身。
    decision: {
      nextStep: "orient",
      reason: "observation_completed",
    },
  };
}
