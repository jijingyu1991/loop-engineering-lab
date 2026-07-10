import { Runner } from "@openai/agents";

import type { ModelConfig } from "../config/config-schema.js";
import { createModelProvider } from "./providers/create-model-provider.js";

export function createRunner(modelConfig: ModelConfig, apiKey: string): Runner {
  const modelProvider = createModelProvider(modelConfig, apiKey);

  return new Runner({
    modelProvider,
    /**
     * This learning project owns a local, provider-independent JSONL trace.
     * SDK trace export is disabled so a DeepSeek credential is never sent to
     * OpenAI's trace exporter and so there is only one trace to reason about.
     */
    tracingDisabled: true,
  });
}
