import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  parseLoopConfig,
  resolveActiveModel,
} from "../../src/config/config-schema.js";
import { createToolRuntimeConfig } from "../../src/agents/tools/tool-runtime-config.js";

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

test("defaults tool configuration for legacy config files", () => {
  const parsed = parseLoopConfig(validConfig);

  assert.equal(parsed.tools.workspaceRoot, ".");
  assert.deepEqual(parsed.tools.shell.allowedExecutables, [
    { executable: "node", argsPrefix: [] },
    { executable: "npm", argsPrefix: ["test"] },
    { executable: "npm", argsPrefix: ["run", "build"] },
    { executable: "git", argsPrefix: ["status"] },
    { executable: "rg", argsPrefix: [] },
  ]);
  assert.deepEqual(parsed.tools.shell.approvalRequiredExecutables, [
    { executable: "npm", argsPrefix: ["install"] },
    { executable: "git", argsPrefix: ["push"] },
  ]);
});

test("rejects an allow rule that shadows an approval rule", () => {
  assert.throws(
    () =>
      parseLoopConfig({
        ...validConfig,
        tools: {
          shell: {
            allowedExecutables: [{ executable: "git", argsPrefix: [] }],
            approvalRequiredExecutables: [
              { executable: "git", argsPrefix: ["push"] },
            ],
          },
        },
      }),
    /Ambiguous shell permission rules/,
  );
});

test("resolves the configured workspace from the process working directory", () => {
  const parsed = parseLoopConfig({
    ...validConfig,
    tools: { workspaceRoot: "project" },
  });

  const runtime = createToolRuntimeConfig(parsed, "/tmp/loop-lab");

  assert.equal(runtime.workspaceRoot, "/tmp/loop-lab/project");
});

test("checked-in config declares global workspace and shell approval rules", async () => {
  const raw = JSON.parse(
    await readFile(
      new URL("../../config/loop.config.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  assert.ok(
    typeof raw === "object" && raw !== null && "tools" in raw,
    "checked-in config must declare tools explicitly",
  );
  const parsed = parseLoopConfig(raw);

  assert.equal(parsed.tools.workspaceRoot, ".");
  assert.ok(
    parsed.tools.shell.allowedExecutables.some(
      (rule) => rule.executable === "rg" && rule.argsPrefix.length === 0,
    ),
  );
  assert.ok(
    parsed.tools.shell.approvalRequiredExecutables.some(
      (rule) =>
        rule.executable === "git" && rule.argsPrefix.join(" ") === "push",
    ),
  );
});
