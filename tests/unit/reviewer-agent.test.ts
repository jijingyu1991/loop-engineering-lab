import assert from "node:assert/strict";
import { test } from "node:test";

import { MaxTurnsExceededError, type Runner } from "@openai/agents";

import type { ModelConfig } from "../../src/config/config-schema.js";
import {
  SubagentMaxStepsExceededError,
} from "../../src/subagents/subagent-invoker.js";
import {
  createReviewerAgent,
  type ReviewerAgent,
} from "../../src/subagents/reviewer/create-reviewer-agent.js";
import {
  reviewerAgentOutputSchema,
} from "../../src/subagents/reviewer/reviewer-contract.js";
import { runReviewerAgent } from "../../src/subagents/reviewer/run-reviewer-agent.js";

const modelConfig: ModelConfig = {
  model: "gpt-5.4-mini",
  baseURL: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  api: "responses",
};

const validResult = {
  contractId: "review-coding-attempt-1",
  role: "reviewer-agent",
  status: "completed",
  summary: "The summary is supported by the supplied trace.",
  evidence: [],
  errors: [],
};

const validReviewerOutput = {
  ...validResult,
  evidence: [
    {
      kind: "review_decision",
      source: "review-coding-attempt-1",
      summary: "pass",
    },
    {
      kind: "trace_reference",
      source: "coding-trace",
      summary: "All checks cite trace index 0.",
    },
  ],
  extensions: {
    decision: "pass",
    checks: [
      {
        criterion: "conclusion_evidence",
        status: "passed",
        summary: "Conclusions cite evidence.",
        traceReferences: [0],
      },
      {
        criterion: "failure_disclosure",
        status: "passed",
        summary: "Failures are disclosed.",
        traceReferences: [0],
      },
      {
        criterion: "required_validation",
        status: "passed",
        summary: "Required validation ran.",
        traceReferences: [0],
      },
    ],
    revisionInstructions: [],
  },
};

test("creates a structured reviewer with no tools", () => {
  const agent = createReviewerAgent(modelConfig);

  assert.deepEqual(agent.tools, []);
  assert.match(String(agent.instructions), /conclusion.*evidence/i);
  assert.match(String(agent.instructions), /failure/i);
  assert.match(String(agent.instructions), /required validation/i);
  assert.match(String(agent.instructions), /must not.*tool/i);
  assert.equal(agent.outputType, reviewerAgentOutputSchema);
  assert.match(String(agent.instructions), /conclusion_evidence/);
  assert.match(String(agent.instructions), /failure_disclosure/);
  assert.match(String(agent.instructions), /required_validation/);
  assert.match(String(agent.instructions), /review_decision.*contract\.id/i);
  assert.match(String(agent.instructions), /trace_reference.*coding-trace/i);
  assert.match(String(agent.instructions), /pass.*all three.*passed/i);
  assert.match(String(agent.instructions), /revise.*failed/i);
  assert.match(String(agent.instructions), /ask_user.*needs_user/i);
});

test("uses a reviewer-specific live output schema", () => {
  assert.deepEqual(
    reviewerAgentOutputSchema.parse(validReviewerOutput),
    validReviewerOutput,
  );
  assert.equal(reviewerAgentOutputSchema.safeParse({
    ...validReviewerOutput,
    role: "search-agent",
  }).success, false);
  assert.equal(reviewerAgentOutputSchema.safeParse({
    ...validReviewerOutput,
    status: "failed",
  }).success, false);
  assert.equal(reviewerAgentOutputSchema.safeParse({
    ...validReviewerOutput,
    extensions: { decision: "pass" },
  }).success, false);
});

test("passes maxSteps and signal to Runner", async () => {
  const controller = new AbortController();
  let options: unknown;
  const runner = {
    run: async (_agent: unknown, _prompt: unknown, received: unknown) => {
      options = received;
      return { finalOutput: validResult, interruptions: [] };
    },
  } as unknown as Runner;

  assert.deepEqual(await runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: [],
    maxSteps: 4,
    signal: controller.signal,
  }), validResult);
  assert.deepEqual(options, { maxTurns: 4, signal: controller.signal });
});

test("rejects a reviewer invocation with permitted tools", async () => {
  const runner = {
    run: async () => assert.fail("runner must not be called"),
  } as unknown as Runner;

  await assert.rejects(runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: ["read"],
    maxSteps: 4,
    signal: new AbortController().signal,
  }), /Reviewer contract must not allow tools/);
});

test("rejects a reviewer interruption", async () => {
  const runner = {
    run: async () => ({
      finalOutput: validResult,
      interruptions: [{}],
    }),
  } as unknown as Runner;

  await assert.rejects(runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: [],
    maxSteps: 4,
    signal: new AbortController().signal,
  }), /Tool-free reviewer returned an interruption/);
});

test("rejects a reviewer response without structured output", async () => {
  const runner = {
    run: async () => ({ finalOutput: undefined, interruptions: [] }),
  } as unknown as Runner;

  await assert.rejects(runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: [],
    maxSteps: 4,
    signal: new AbortController().signal,
  }), /Reviewer returned no structured output/);
});

test("maps SDK max turns exhaustion to the provider-neutral error", async () => {
  const runner = {
    run: async () => { throw new MaxTurnsExceededError("max turns reached"); },
  } as unknown as Runner;

  await assert.rejects(runReviewerAgent({
    runner,
    agent: {} as ReviewerAgent,
    prompt: "review",
    allowedTools: [],
    maxSteps: 4,
    signal: new AbortController().signal,
  }), SubagentMaxStepsExceededError);
});
