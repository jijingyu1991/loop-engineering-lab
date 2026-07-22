import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentInputItem } from "@openai/agents";

import {
  groupContextItems,
  measureModelInput,
} from "../../src/context/context-item-groups.js";
import { summarizeFunctionResult } from "../../src/context/summarize-tool-result.js";

const call = {
  type: "function_call" as const,
  callId: "call-1",
  name: "workspace_shell",
  arguments: JSON.stringify({ executable: "npm", args: ["test"] }),
};

const result = {
  type: "function_call_result" as const,
  callId: "call-1",
  name: "workspace_shell",
  status: "completed" as const,
  output: JSON.stringify({ ok: true, data: { stdout: "x".repeat(2_000) } }),
};

test("measures instructions and input with one canonical JSON serialization", () => {
  const instructions = "Preserve useful evidence.";
  const input: AgentInputItem[] = [
    { role: "user", content: "diagnose" },
    call,
  ];

  assert.equal(
    measureModelInput(instructions, input),
    JSON.stringify({ instructions, input }).length,
  );
});

test("groups a function call and result atomically", () => {
  const groups = groupContextItems([
    { role: "user", content: "diagnose" },
    call,
    result,
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1]?.items, [call, result]);
  assert.equal(groups[1]?.callId, "call-1");
});

test("rejects an orphan function result", () => {
  assert.throws(
    () => groupContextItems([result]),
    /orphan function result/i,
  );
});

test("rejects a function result that appears before its call", () => {
  assert.throws(
    () => groupContextItems([result, call]),
    /orphan function result/i,
  );
});

test("summarizes successful tool output deterministically within its budget", () => {
  const [group] = groupContextItems([call, result]);
  assert.ok(group);

  const first = summarizeFunctionResult(group, 480);
  const second = summarizeFunctionResult(group, 480);
  const output = JSON.parse(String(first.item.output)) as Record<string, unknown>;
  const excerpt = output.excerpt as Record<string, unknown>;

  assert.deepEqual(first, second);
  assert.equal(output.compacted, true);
  assert.equal(output.callId, "call-1");
  assert.equal(output.tool, "workspace_shell");
  assert.equal(output.originalChars, result.output.length);
  assert.equal(typeof output.source, "string");
  assert.equal(typeof excerpt.omittedChars, "number");
  assert.ok(String(first.item.output).length <= 480);
  assert.equal(first.manifest.status, "succeeded");
});

test("preserves required failed-tool evidence or fails closed when it cannot fit", () => {
  const failedResult = {
    type: "function_call_result" as const,
    callId: "call-failed",
    name: "workspace_shell",
    status: "completed" as const,
    output: JSON.stringify({
      ok: false,
      error: {
        type: "process_failed",
        message: "Focused test failed.",
        retryable: true,
        userActionRequired: false,
        suggestedNextStep: "Inspect the assertion diff.",
        evidence: { exitCode: 1, command: "npm test" },
      },
    }),
  };
  const [group] = groupContextItems([
    { ...call, callId: "call-failed" },
    failedResult,
  ]);
  assert.ok(group);

  const summary = summarizeFunctionResult(group, 800);
  const output = JSON.parse(String(summary.item.output)) as Record<string, unknown>;
  const error = output.error as Record<string, unknown>;

  assert.deepEqual(error, {
    type: "process_failed",
    message: "Focused test failed.",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Inspect the assertion diff.",
    evidence: { exitCode: 1, command: "npm test" },
  });
  assert.equal(output.conclusion, "attempt_failed");
  assert.ok(String(summary.item.output).length <= 800);
  assert.equal(summary.manifest.status, "failed");

  assert.throws(
    () => summarizeFunctionResult(group, 20),
    (error: unknown) =>
      error instanceof Error &&
      "reason" in error &&
      error.reason === "pinned_content_exceeds_budget",
  );
});
