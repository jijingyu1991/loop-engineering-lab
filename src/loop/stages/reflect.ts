import type { ReflectData, VerifyData } from "../../domain/loop-step.js";

export interface ReflectInput {
  actionOutput: string;
  verification: VerifyData;
}

/** Produce minimal feedback that the next observe stage can consume. */
export async function runReflect(input: ReflectInput): Promise<ReflectData> {
  return {
    summary: input.actionOutput,
    nextFocus: input.verification.passed
      ? null
      : "Use the previous output as context for the next iteration.",
  };
}
