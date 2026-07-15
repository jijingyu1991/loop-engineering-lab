import { Agent, type Tool } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";
import { codingOutputSchema } from "./coding-output.js";

export type CodingAgent = Agent<unknown, typeof codingOutputSchema>;

/**
 * Coding Agent 可以读取、搜索并运行配置允许的诊断命令，但工具集合由组合层注入。
 * 这里通过 instructions 再声明一次只读边界，防止模型借 shell 间接尝试写文件。
 */
export function createCodingAgent(
  modelConfig: ModelConfig,
  tools: Tool[],
): CodingAgent {
  return Agent.create({
    name: "Read-only Coding Agent",
    model: modelConfig.model,
    outputType: codingOutputSchema,
    instructions: [
      "Complete the requested coding analysis using local evidence from the supplied workspace tools.",
      "You must not claim that you made file changes because this milestone is read-only.",
      "You must not attempt file writes through shell commands or indirect shell side effects.",
      "Configured tests and builds may generate their normal output artifacts, but do not intentionally edit source files.",
      "Treat nonzero test output as diagnostic evidence, not as an automatic failure of the analysis task.",
      "For implementation-planning responses, state the exact sentence: No files were modified.",
      "Cite every important conclusion in the evidence array with a useful kind, source, and summary.",
      "Return concise Chinese when the request is Chinese; otherwise answer in the request language.",
    ].join(" "),
    tools,
  });
}
