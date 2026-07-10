import type { ObserveData, OrientData } from "../../domain/loop-step.js";

/**
 * Skeleton orientation intentionally stays simple. The `source: skeleton`
 * marker lives in the stage envelope so readers never confuse this helper with
 * a model-produced analysis.
 */
export async function runOrient(observation: ObserveData): Promise<OrientData> {
  return {
    objective: observation.task,
    constraints: observation.previousAction
      ? ["Improve on the previous action output."]
      : ["Produce the first useful action output."],
  };
}
