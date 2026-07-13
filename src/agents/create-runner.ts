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
  });
}
