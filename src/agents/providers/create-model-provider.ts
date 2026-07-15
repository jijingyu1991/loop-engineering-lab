import { OpenAIProvider, type ModelProvider } from "@openai/agents";

import type { ModelConfig } from "../../config/config-schema.js";
import { createJsonObjectModelProvider } from "./create-json-object-model-provider.js";

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
): ModelProvider {
  const provider = new OpenAIProvider(toProviderOptions(modelConfig, apiKey));

  // Responses API 原生支持 Agent 的 JSON Schema 输出；DeepSeek 使用兼容的
  // Chat Completions API，只接受 JSON Object，因此仅在该 provider 分支增加适配。
  return modelConfig.api === "chat_completions"
    ? createJsonObjectModelProvider(provider)
    : provider;
}
