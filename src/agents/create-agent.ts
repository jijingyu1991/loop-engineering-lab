import { Agent, type Tool } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";

/**
 * Agent 的构造与 loop 隔离。以后可以在这里添加 tools 和 guardrails，
 * 而不必让 `loop-runner.ts` 理解 Agents SDK 的概念。
 */
export function createActorAgent(
  modelConfig: ModelConfig,
  tools: Tool[],
): Agent {
  return new Agent({
    name: "Loop Actor",
    model: modelConfig.model,
    instructions: [
      "You execute one concrete action in a larger engineering loop.",
      "Use the observation and plan supplied by the caller.",
      "Use workspace_file, workspace_search, and workspace_shell when local evidence or changes are required.",
      "Every local tool returns a ToolResult JSON object; on failure, use error.retryable, error.userActionRequired, error.suggestedNextStep, and error.evidence to decide what to do.",
      "Do not repeat a non-retryable call without changing its inputs or satisfying the requested user action.",
      "Return only the useful action result, without discussing loop control.",
    ].join(" "),
    tools,
  });
}
