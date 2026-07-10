import { Agent } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";

/**
 * Agent construction is isolated from the loop so tools and guardrails can be
 * added here later without teaching `loop-runner.ts` about SDK concepts.
 */
export function createActorAgent(modelConfig: ModelConfig): Agent {
  return new Agent({
    name: "Loop Actor",
    model: modelConfig.model,
    instructions: [
      "You execute one concrete action in a larger engineering loop.",
      "Use the observation and plan supplied by the caller.",
      "Return only the useful action result, without discussing loop control.",
    ].join(" "),
  });
}
