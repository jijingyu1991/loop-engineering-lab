import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseLoopConfig,
  resolveActiveModel,
} from "../../src/config/config-schema.js";

const validConfig = {
  activeModel: "gpt",
  models: {
    gpt: {
      model: "gpt-5.4-mini",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      api: "responses",
    },
    deepseek: {
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      api: "chat_completions",
    },
  },
  safetyLimits: { maxSteps: 3, maxTurns: 5 },
  tracePath: "traces/loop.jsonl",
} as const;

test("selects a model by the activeModel logical name", () => {
  const parsed = parseLoopConfig(validConfig);

  assert.equal(parsed.models[parsed.activeModel]?.model, "gpt-5.4-mini");
});

test("rejects an unknown activeModel", () => {
  assert.throws(
    () => parseLoopConfig({ ...validConfig, activeModel: "missing" }),
    /Unknown activeModel: missing/,
  );
});

test("resolves only the selected model API key", () => {
  const parsed = parseLoopConfig(validConfig);
  const loaded = resolveActiveModel(parsed, {
    OPENAI_API_KEY: "openai-test-key",
  });

  assert.equal(loaded.activeModelName, "gpt");
  assert.equal(loaded.apiKey, "openai-test-key");
});

test("names the missing environment variable without exposing a value", () => {
  const parsed = parseLoopConfig(validConfig);

  assert.throws(
    () => resolveActiveModel(parsed, {}),
    /Missing API key environment variable: OPENAI_API_KEY/,
  );
});
