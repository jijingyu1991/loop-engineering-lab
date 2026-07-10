import type { LoopStep, ObserveData } from "../../domain/loop-step.js";

export interface ObserveInput {
  task: string;
  previousStep?: LoopStep;
}

/** Build the next iteration's context from durable loop state. */
export function runObserve(input: ObserveInput): ObserveData {
  return {
    task: input.task,
    previousAction: input.previousStep?.act.data?.output ?? null,
    previousReflection: input.previousStep?.reflect.data?.summary ?? null,
  };
}
