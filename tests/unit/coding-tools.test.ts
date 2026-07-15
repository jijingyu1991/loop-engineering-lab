import assert from "node:assert/strict";
import { test } from "node:test";

import { RunContext } from "@openai/agents";

import { createCodingTools } from "../../src/agents/tools/create-coding-tools.js";
import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import { resolveShellPermission } from "../../src/agents/tools/tool-permission.js";
import {
  createCodingToolRuntimeConfig,
  createToolRuntimeConfig,
  type ToolRuntimeConfig,
} from "../../src/agents/tools/tool-runtime-config.js";
import { parseLoopConfig } from "../../src/config/config-schema.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

function configuredRuntime(): ToolRuntimeConfig {
  const config = parseLoopConfig({
    activeModel: "test",
    models: {
      test: {
        model: "test-model",
        baseURL: "https://example.com/v1",
        apiKeyEnv: "TEST_API_KEY",
        api: "responses",
      },
    },
    safetyLimits: { maxSteps: 2, maxTurns: 3 },
    tracePath: "traces/test.jsonl",
  });
  return createToolRuntimeConfig(config, process.cwd());
}

test("narrows the coding shell policy without changing the default runtime", () => {
  const defaultRuntime = configuredRuntime();
  const codingRuntime = createCodingToolRuntimeConfig(defaultRuntime);

  assert.deepEqual(codingRuntime.shell.allowedExecutables, [
    { executable: "npm", argsPrefix: ["test"], argsMatch: "exact" },
    {
      executable: "npm",
      argsPrefix: ["run", "build"],
      argsMatch: "exact",
    },
    { executable: "git", argsPrefix: ["status"], argsMatch: "exact" },
  ]);
  assert.deepEqual(codingRuntime.shell.approvalRequiredExecutables, []);
  assert.ok(
    defaultRuntime.shell.allowedExecutables.some(
      (rule) => rule.executable === "node" && rule.argsPrefix.length === 0,
    ),
  );
  assert.notEqual(codingRuntime.shell, defaultRuntime.shell);
});

test("allows exact coding diagnostics and denies prefix-tail escapes", () => {
  const shell = createCodingToolRuntimeConfig(configuredRuntime()).shell;

  assert.equal(
    resolveShellPermission({ executable: "npm", args: ["test"] }, shell),
    "allowed",
  );
  assert.equal(
    resolveShellPermission(
      { executable: "npm", args: ["run", "build"] },
      shell,
    ),
    "allowed",
  );
  assert.equal(
    resolveShellPermission({ executable: "git", args: ["status"] }, shell),
    "allowed",
  );
  assert.equal(
    resolveShellPermission(
      {
        executable: "npm",
        args: ["run", "build", "--", "--outDir", "/tmp/out"],
      },
      shell,
    ),
    "denied",
  );
  assert.equal(
    resolveShellPermission(
      { executable: "git", args: ["status", "--short"] },
      shell,
    ),
    "denied",
  );
});

test("assembles only read, search, and policy-limited shell tools", () => {
  const tools = createCodingTools(
    createCodingToolRuntimeConfig(configuredRuntime()),
    new MemoryTraceWriter(),
    createToolOutcomeRecorder(),
  );

  assert.deepEqual(
    tools.map((item) => item.name),
    ["workspace_file_read", "workspace_search", "workspace_shell"],
  );
});

test("keeps coding shell adapter validation failures structured and traced", async () => {
  const traceWriter = new MemoryTraceWriter();
  const tools = createCodingTools(
    createCodingToolRuntimeConfig(configuredRuntime()),
    traceWriter,
    createToolOutcomeRecorder(),
  );
  const shellTool = tools.find((item) => item.name === "workspace_shell");
  assert.ok(shellTool && shellTool.type === "function");

  const output = await shellTool.invoke(
    new RunContext(),
    JSON.stringify({ executable: "node", args: "not-an-array", cwd: "." }),
  );
  const result = typeof output === "string"
    ? JSON.parse(output) as { ok: boolean; error: { type: string } }
    : output as { ok: boolean; error: { type: string } };

  assert.equal(result.ok, false);
  assert.equal(result.error.type, "invalid_input");
  assert.ok(traceWriter.events.some(
    (event) => event.event === "tool_failed" && event.operation === "adapter",
  ));
});
