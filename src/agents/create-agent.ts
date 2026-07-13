import { Agent } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";

/**
 * Agent 的构造与 loop 隔离。以后可以在这里添加 tools 和 guardrails，
 * 而不必让 `loop-runner.ts` 理解 Agents SDK 的概念。
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
