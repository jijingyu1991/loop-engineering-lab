import { OpenAIProvider } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";

export interface ProviderOptions {
  apiKey: string;
  baseURL: string;
  useResponses: boolean;
}

/**
 * 把与 provider 无关的项目配置转换为 OpenAIProvider 所需的最小选项集合。
 * DeepSeek 暴露了兼容 OpenAI 的 Chat Completions API，因此两种 provider
 * 可以共用同一个 SDK 适配器，只需切换配置。
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
