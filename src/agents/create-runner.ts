import { Runner } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";
import { createModelProvider } from "./providers/create-model-provider.js";

export function createRunner(modelConfig: ModelConfig, apiKey: string): Runner {
  const modelProvider = createModelProvider(modelConfig, apiKey);

  return new Runner({
    modelProvider,
    /**
     * 这个学习项目维护一套本地、与 provider 无关的 JSONL trace。
     * 禁用 SDK trace 导出既能避免把 DeepSeek 凭据发送给 OpenAI 的 trace
     * exporter，也能保证学习和排查时只需理解一套 trace。
     */
    tracingDisabled: true,
    // SDK 默认把审批拒绝降级成普通文本。这里取回 `state.reject(..., { message })`
    // 保存的 JSON contract，使模型能继续按统一的 retry/user-action 字段决策。
    toolErrorFormatter: ({
      kind,
      toolName,
      callId,
      runContext,
    }) =>
      kind === "approval_rejected"
        ? runContext.getRejectionMessage(toolName, callId)
        : undefined,
  });
}
