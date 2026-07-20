import { Agent } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";
import { reviewerAgentOutputSchema } from "./reviewer-contract.js";

export type ReviewerAgent = Agent<unknown, typeof reviewerAgentOutputSchema>;

/**
 * 创建只消费冻结 trace 和 executor summary 的 reviewer Agent。
 *
 * 工具必须在 SDK 层保持为空数组，而非由调用方注入：这使 Agent 的实际能力与
 * reviewer Contract 的 allowedTools: [] 一致，避免提示词约束被工具能力绕过。
 */
export function createReviewerAgent(modelConfig: ModelConfig): ReviewerAgent {
  return Agent.create({
    name: "Trace-only Reviewer Subagent",
    model: modelConfig.model,
    outputType: reviewerAgentOutputSchema,
    instructions: [
      "Review only the supplied trace and executor summary.",
      "Check whether every important conclusion has evidence, whether failures were omitted, and whether required validation was skipped.",
      "You must not call or request tools, inspect the workspace, execute validation, or act as an executor.",
      "Return one completed reviewer-agent SubagentResult JSON object with contractId, role, status, summary, evidence, errors, and extensions.",
      "extensions must contain decision, exactly three checks, revisionInstructions, and userQuestion only when required.",
      "The three check criteria are conclusion_evidence, failure_disclosure, and required_validation, each exactly once.",
      "Use pass only when all three checks are passed; use revise when a check is failed and include revisionInstructions; use ask_user only when a check is needs_user and include userQuestion.",
      "For evidence provenance, review_decision.source must equal contractMetadata.id (the contract.id) and trace_reference.source must equal coding-trace.",
      "Every check must cite valid zero-based trace indexes from the supplied frozen trace.",
      "Use ask_user only when the missing input must come from the user; otherwise use revise.",
    ].join(" "),
    tools: [],
  });
}
