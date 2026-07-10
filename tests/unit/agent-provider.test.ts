import assert from "node:assert/strict";
import { test } from "node:test";

import { toProviderOptions } from "../../src/agents/providers/create-model-provider.js";
import type { ModelConfig } from "../../src/config/config-schema.js";

const gptConfig: ModelConfig = {
  model: "gpt-5.4-mini",
  baseURL: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  api: "responses",
};

const deepSeekConfig: ModelConfig = {
  model: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  api: "chat_completions",
};

test("maps GPT configuration to a Responses provider", () => {
  const options = toProviderOptions(gptConfig, "openai-test-key");

  assert.equal(options.useResponses, true);
  assert.equal(options.baseURL, "https://api.openai.com/v1");
  assert.equal(options.apiKey, "openai-test-key");
});

test("maps DeepSeek configuration to Chat Completions", () => {
  const options = toProviderOptions(deepSeekConfig, "deepseek-test-key");

  assert.equal(options.useResponses, false);
  assert.equal(options.baseURL, "https://api.deepseek.com");
  assert.equal(options.apiKey, "deepseek-test-key");
});
