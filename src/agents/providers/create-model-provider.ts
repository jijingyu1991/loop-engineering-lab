import { OpenAIProvider } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";

export interface ProviderOptions {
  apiKey: string;
  baseURL: string;
  useResponses: boolean;
}

/**
 * Convert our provider-neutral config into the small option set required by
 * OpenAIProvider. DeepSeek exposes an OpenAI-compatible Chat Completions API,
 * so both providers share the same SDK adapter; only configuration changes.
 */
export function toProviderOptions(
  modelConfig: ModelConfig,
  apiKey: string,
): ProviderOptions {
  return {
    apiKey,
    baseURL: modelConfig.baseURL,
    useResponses: modelConfig.api === "responses",
  };
}

export function createModelProvider(
  modelConfig: ModelConfig,
  apiKey: string,
): OpenAIProvider {
  return new OpenAIProvider(toProviderOptions(modelConfig, apiKey));
}
