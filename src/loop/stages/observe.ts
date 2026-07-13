import type { LoopStep, ObserveData } from "../../domain/loop-step.js";

export interface ObserveInput {
  task: string;
  previousStep?: LoopStep;
}

/** 从持久化的 loop 状态中构造下一轮迭代所需的上下文。 */
export function runObserve(input: ObserveInput): ObserveData {
  return {
    task: input.task,
    previousAction: input.previousStep?.act.data?.output ?? null,
    previousReflection: input.previousStep?.reflect.data?.summary ?? null,
  };
}
