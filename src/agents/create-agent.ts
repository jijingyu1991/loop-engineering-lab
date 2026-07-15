import { Agent, type Tool } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";
import { actorOutputSchema } from "./actor-output.js";

export type ActorAgent = Agent<unknown, typeof actorOutputSchema>;

/**
 * Agent 的构造与 loop 隔离。以后可以在这里添加 tools 和 guardrails，
 * 而不必让 `loop-runner.ts` 理解 Agents SDK 的概念。
 */
export function createActorAgent(
  modelConfig: ModelConfig,
  tools: Tool[],
): ActorAgent {
  return Agent.create({
    name: "Loop Actor",
    model: modelConfig.model,
    outputType: actorOutputSchema,
    instructions: [
      "You execute one concrete action in a larger engineering loop.",
      "Use the observation and plan supplied by the caller.",
      "Use workspace_file, workspace_search, and workspace_shell when local evidence or changes are required.",
      "If the task explicitly asks to execute a shell command, you must call workspace_shell with the requested executable and arguments.",
      "Approval must be requested through the tool call interruption; never ask for approval only in text or final output.",
      "Never return final structured output before the required tool call finishes or the runtime reports that approval was rejected or unavailable.",
      "Every local tool returns a ToolResult JSON object; on failure, use error.retryable, error.userActionRequired, error.suggestedNextStep, and error.evidence to decide what to do.",
      "Do not repeat a non-retryable call without changing its inputs or satisfying the requested user action.",
      "Return outcome=succeeded only when the objective is complete.",
      "Return outcome=continue when another loop iteration can make progress.",
      "Return failed, blocked, or cancelled only when no safe alternative remains.",
      "After a rejected command, try an allowed alternative before returning cancelled.",
      "Put the useful action result in output without discussing loop control.",
    ].join(" "),
    tools,
  });
}
