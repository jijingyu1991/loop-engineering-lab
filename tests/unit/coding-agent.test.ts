import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunToolApprovalItem, Runner, Tool } from "@openai/agents";

import {
  classifyCodingRequest,
  createCodingClassifierAgent,
  type CodingClassifierAgent,
} from "../../src/modes/coding/coding-classifier.js";
import {
  createCodingAgent,
  type CodingAgent,
} from "../../src/modes/coding/create-coding-agent.js";
import { runCodingAgent } from "../../src/modes/coding/run-coding-agent.js";
import type { ModelConfig } from "../../src/config/config-schema.js";
import type { TraceEvent } from "../../src/trace/trace-event.js";
import type { TraceWriter } from "../../src/trace/jsonl-trace-writer.js";

class MemoryTraceWriter implements TraceWriter {
  public readonly events: TraceEvent[] = [];

  public async write(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }
}

const modelConfig: ModelConfig = {
  model: "gpt-5.4-mini",
  baseURL: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  api: "responses",
};

test("creates a tool-free structured coding classifier", () => {
  const agent = createCodingClassifierAgent(modelConfig);

  assert.deepEqual(agent.tools, []);
  assert.match(String(agent.instructions), /propose_implementation_plan/);
  assert.match(String(agent.instructions), /create, implement, refactor, or fix code/);
});

test("forbids presenting a plan fallback as completed implementation", () => {
  const agent = createCodingClassifierAgent(modelConfig);

  assert.match(
    String(agent.instructions),
    /must not present.*propose_implementation_plan.*completed implementation/i,
  );
});

test("returns structured classifier output", async () => {
  const expected = {
    taskType: "explain_module" as const,
    objective: "Explain src/loop",
    reason: "The request asks how a module works",
  };
  const runner = {
    run: async () => ({ finalOutput: expected, interruptions: [] }),
  } as unknown as Runner;

  assert.deepEqual(
    await classifyCodingRequest(
      runner,
      {} as CodingClassifierAgent,
      "解释 loop",
    ),
    expected,
  );
});

test("trims classifier input before invoking the runner", async () => {
  let receivedRequest: unknown;
  let receivedOptions: unknown;
  const runner = {
    run: async (_agent: unknown, request: unknown, options: unknown) => {
      receivedRequest = request;
      receivedOptions = options;
      return {
        finalOutput: {
          taskType: "find_related_files" as const,
          objective: "Find related files",
          reason: "The request asks for related files",
        },
        interruptions: [],
      };
    },
  } as unknown as Runner;

  await classifyCodingRequest(
    runner,
    {} as CodingClassifierAgent,
    "  find files  ",
    4,
  );

  assert.equal(receivedRequest, "find files");
  assert.deepEqual(receivedOptions, { maxTurns: 4 });
});

test("rejects an empty classifier request", async () => {
  const runner = {
    run: async () => assert.fail("runner must not be called"),
  } as unknown as Runner;

  await assert.rejects(
    classifyCodingRequest(runner, {} as CodingClassifierAgent, "   "),
    /Coding request must not be empty/,
  );
});

test("rejects a classifier response without final output", async () => {
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [] }),
  } as unknown as Runner;

  await assert.rejects(
    classifyCodingRequest(runner, {} as CodingClassifierAgent, "解释 loop"),
    /Classifier returned no structured output/,
  );
});

test("creates a structured coding agent with supplied tools", () => {
  const tools: Tool[] = [];
  const agent = createCodingAgent(modelConfig, tools);

  assert.equal(agent.tools, tools);
  assert.match(String(agent.instructions), /local evidence/i);
  assert.match(String(agent.instructions), /must not claim.*file changes/i);
  assert.match(String(agent.instructions), /must not.*file writes.*shell/i);
  assert.match(String(agent.instructions), /nonzero test.*diagnostic evidence/i);
  assert.match(String(agent.instructions), /concise Chinese/i);
});

test("requires implementation plans to disclose that no files changed", () => {
  const agent = createCodingAgent(modelConfig, []);

  assert.match(
    String(agent.instructions),
    /implementation-planning responses.*No files were modified\./,
  );
});

test("turns a coding tool interruption into approval_required", async () => {
  const argumentsJson = JSON.stringify({
    executable: "git",
    args: ["push", "https://example.test/sk-secret123456/repo"],
    cwd: ".",
  });
  const interruption = {
    name: "workspace_shell",
    arguments: argumentsJson,
    rawItem: {
      type: "function_call",
      callId: "call-coding-1",
      name: "workspace_shell",
      arguments: argumentsJson,
    },
  } as unknown as RunToolApprovalItem;
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [interruption] }),
  } as unknown as Runner;
  const traceWriter = new MemoryTraceWriter();

  const result = await runCodingAgent({
    runner,
    agent: {} as CodingAgent,
    prompt: "diagnose",
    maxTurns: 5,
    traceWriter,
    now: () => "2026-07-15T00:00:00.000Z",
  });

  assert.deepEqual(result, {
    type: "stopped",
    status: "blocked",
    reason: "approval_required",
  });
  assert.deepEqual(traceWriter.events, [{
    event: "tool_approval_requested",
    timestamp: "2026-07-15T00:00:00.000Z",
    tool: "shell",
    toolCallId: "call-coding-1",
    input: {
      executable: "git",
      arguments: ["push", "https://example.test/[REDACTED]/repo"],
      argsCount: 2,
      cwd: ".",
    },
  }]);
});

test("returns runtime_error when the coding agent has no final output", async () => {
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [] }),
  } as unknown as Runner;

  assert.deepEqual(await runCodingAgent({
    runner,
    agent: {} as CodingAgent,
    prompt: "diagnose",
    maxTurns: 5,
    traceWriter: new MemoryTraceWriter(),
  }), {
    type: "stopped",
    status: "failed",
    reason: "runtime_error",
  });
});

test("keeps a nonzero test exit as completed diagnostic evidence", async () => {
  const finalOutput = {
    output: "The assertion failed because the expected status differs.",
    evidence: [{
      kind: "test-output",
      source: "npm test",
      summary: "exitCode=1; assertion expected completed but received failed",
    }],
  };
  const runner = {
    run: async () => ({ finalOutput, interruptions: [] }),
  } as unknown as Runner;

  assert.deepEqual(await runCodingAgent({
    runner,
    agent: {} as CodingAgent,
    prompt: "diagnose the failing test",
    maxTurns: 5,
    traceWriter: new MemoryTraceWriter(),
  }), {
    type: "completed",
    ...finalOutput,
  });
});
