import type { Runner } from "@openai/agents";

import type { CodingExecutorResult } from "./coding-state.js";
import type { CodingAgent } from "./create-coding-agent.js";

export async function runCodingAgent(input: {
  runner: Runner;
  agent: CodingAgent;
  prompt: string;
  maxTurns: number;
}): Promise<CodingExecutorResult> {
  const result = await input.runner.run(input.agent, input.prompt, {
    maxTurns: input.maxTurns,
  });

  // 中断比 finalOutput 缺失更具体；当前里程碑不保存或恢复 SDK RunState，
  // 因此把任何工具审批中断稳定映射成上层可理解的 blocked 终态。
  if (result.interruptions.length > 0) {
    return {
      type: "stopped",
      status: "blocked",
      reason: "approval_required",
    };
  }

  if (!result.finalOutput) {
    return {
      type: "stopped",
      status: "failed",
      reason: "runtime_error",
    };
  }

  return {
    type: "completed",
    output: result.finalOutput.output,
    evidence: result.finalOutput.evidence,
  };
}
