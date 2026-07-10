import type { Agent, Runner } from "@openai/agents";

import type {
  ActData,
  ObserveData,
  PlanData,
} from "../../domain/loop-step.js";

export interface ActInput {
  runner: Runner;
  agent: Agent;
  observation: ObserveData;
  plan: PlanData;
  maxTurns: number;
}

/**
 * Execute the only model-backed stage in the first version.
 *
 * `maxTurns` limits the Agents SDK's internal loop (model → tool/handoff →
 * model). It is intentionally different from `maxSteps`, which limits how
 * many complete observe→stop iterations our outer loop may run.
 */
export async function runAct(input: ActInput): Promise<ActData> {
  const prompt = [
    `Task: ${input.observation.task}`,
    `Previous action: ${input.observation.previousAction ?? "none"}`,
    `Previous reflection: ${input.observation.previousReflection ?? "none"}`,
    `Planned action: ${input.plan.nextAction}`,
  ].join("\n");

  const result = await input.runner.run(input.agent, prompt, {
    maxTurns: input.maxTurns,
  });

  if (typeof result.finalOutput !== "string" || !result.finalOutput.trim()) {
    throw new Error("Agent returned an empty text output");
  }

  return { output: result.finalOutput.trim() };
}
