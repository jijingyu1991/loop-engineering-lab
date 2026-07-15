import assert from "node:assert/strict";
import { test } from "node:test";

import { RunContext } from "@openai/agents";

import { createActorAgent } from "../../src/agents/create-agent.js";
import { createAgentTools } from "../../src/agents/tools/create-agent-tools.js";
import { createToolOutcomeRecorder } from "../../src/agents/tools/tool-outcome-recorder.js";
import type { ToolRuntimeConfig } from "../../src/agents/tools/tool-runtime-config.js";
import type { ModelConfig } from "../../src/config/config-schema.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

const modelConfig: ModelConfig = {
  model: "gpt-5.4-mini",
  baseURL: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  api: "responses",
};

const runtime: ToolRuntimeConfig = {
  workspaceRoot: process.cwd(),
  file: { maxReadChars: 100_000 },
  search: { maxMatches: 200, maxOutputChars: 20_000 },
  shell: {
    allowedExecutables: [{ executable: "rg", argsPrefix: [] }],
    approvalRequiredExecutables: [
      { executable: "git", argsPrefix: ["push"] },
    ],
    timeoutMs: 10_000,
    maxOutputChars: 20_000,
  },
};

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];
  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

test("registers file, search, and shell tools on the actor", () => {
  const tools = createAgentTools(
    runtime,
    new MemoryTraceWriter(),
    createToolOutcomeRecorder(),
  );
  const agent = createActorAgent(modelConfig, tools);

  assert.deepEqual(
    agent.tools.map((item) => item.name),
    ["workspace_file", "workspace_search", "workspace_shell"],
  );
});

test("requires explicit execution tasks to call the matching tool first", () => {
  const agent = createActorAgent(modelConfig, []);

  assert.equal(typeof agent.instructions, "string");
  assert.match(
    String(agent.instructions),
    /explicitly asks to execute a shell command, you must call workspace_shell/,
  );
  assert.match(
    String(agent.instructions),
    /Approval must be requested through the tool call interruption/,
  );
  assert.match(
    String(agent.instructions),
    /Never return final structured output before the required tool call finishes/,
  );
});

test("keeps adapter validation failures structured and traceable", async () => {
  const traceWriter = new MemoryTraceWriter();
  const tools = createAgentTools(runtime, traceWriter, createToolOutcomeRecorder());
  const fileTool = tools.find((item) => item.name === "workspace_file");
  assert.ok(fileTool && fileTool.type === "function");

  const output = await fileTool.invoke(
    new RunContext(),
    JSON.stringify({
      action: "read",
      path: "",
      content: null,
      overwrite: false,
    }),
  );
  const result = typeof output === "string"
    ? JSON.parse(output) as { ok: boolean; error: { type: string } }
    : output as { ok: boolean; error: { type: string } };

  assert.equal(result.ok, false);
  assert.equal(result.error.type, "invalid_input");
  assert.ok(
    traceWriter.events.some(
      (event) =>
        event.event === "tool_failed" && event.operation === "adapter",
    ),
  );
});

test("traces semantic file input failures before returning them to the Agent", async () => {
  const traceWriter = new MemoryTraceWriter();
  const tools = createAgentTools(runtime, traceWriter, createToolOutcomeRecorder());
  const fileTool = tools.find((item) => item.name === "workspace_file");
  assert.ok(fileTool && fileTool.type === "function");

  const output = await fileTool.invoke(
    new RunContext(),
    JSON.stringify({
      action: "write",
      path: "new.txt",
      content: null,
      overwrite: false,
    }),
  );
  const result = typeof output === "string"
    ? JSON.parse(output) as { ok: boolean; error: { type: string } }
    : output as unknown as { ok: boolean; error: { type: string } };

  assert.equal(result.ok, false);
  assert.equal(result.error.type, "invalid_input");
  assert.ok(
    traceWriter.events.some(
      (event) =>
        event.event === "tool_failed" && event.operation === "write",
    ),
  );
});

test("traces only a search pattern summary, not the raw pattern", async () => {
  const traceWriter = new MemoryTraceWriter();
  const tools = createAgentTools(runtime, traceWriter, createToolOutcomeRecorder());
  const searchTool = tools.find((item) => item.name === "workspace_search");
  assert.ok(searchTool && searchTool.type === "function");
  const pattern = "sensitive-search-token";

  await searchTool.invoke(
    new RunContext(),
    JSON.stringify({ pattern, path: ".", regex: false, glob: null }),
  );

  const started = traceWriter.events.find(
    (event) => event.event === "tool_started" && event.tool === "search",
  );
  assert.equal(started?.event, "tool_started");
  if (started?.event === "tool_started") {
    assert.equal("pattern" in started.input, false);
    assert.equal(started.input.patternChars, pattern.length);
  }
});
