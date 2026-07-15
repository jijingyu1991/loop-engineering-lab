import { Agent, type Runner } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";
import {
  codingTaskClassificationSchema,
  type CodingTaskClassification,
} from "./coding-task.js";

export type CodingClassifierAgent = Agent<
  unknown,
  typeof codingTaskClassificationSchema
>;

/**
 * 分类 Agent 不安装任何工具：它只负责把用户意图收敛到稳定的领域合同，
 * 不能在分类阶段读取工作区、执行命令或越过当前里程碑的只读边界。
 */
export function createCodingClassifierAgent(
  modelConfig: ModelConfig,
): CodingClassifierAgent {
  return Agent.create({
    name: "Coding Request Classifier",
    model: modelConfig.model,
    outputType: codingTaskClassificationSchema,
    instructions: [
      "Classify the coding request into exactly one supported task type.",
      "Use explain_module when the user asks how a module or code path works.",
      "Use find_related_files when the user asks which local files relate to a topic or change.",
      "Use diagnose_test_failure when the user asks why a test or build failed.",
      "Use propose_implementation_plan when the user asks for an implementation approach or plan.",
      "For this read-only milestone, requests to create, implement, refactor, or fix code must map to propose_implementation_plan.",
      "Keep objective concrete and explain the classification briefly in reason.",
    ].join(" "),
    tools: [],
  });
}

export async function classifyCodingRequest(
  runner: Runner,
  agent: CodingClassifierAgent,
  request: string,
  maxTurns = 3,
): Promise<CodingTaskClassification> {
  const normalizedRequest = request.trim();
  if (!normalizedRequest) {
    throw new Error("Coding request must not be empty");
  }

  const result = await runner.run(agent, normalizedRequest, { maxTurns });
  if (!result.finalOutput) {
    throw new Error("Classifier returned no structured output");
  }

  return result.finalOutput;
}
