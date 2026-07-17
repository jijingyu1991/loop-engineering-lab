import assert from "node:assert/strict";
import { test } from "node:test";

import {
  subagentContractSchema,
  subagentResultSchema,
  validateSubagentResult,
  type SubagentContract,
  type SubagentResult,
} from "../../src/domain/subagent-contract.js";

const validContract: SubagentContract = {
  id: "search-related-files",
  role: "search-agent",
  task: "Find files related to workflow transitions.",
  scope: {
    include: ["src/runtime"],
    exclude: ["src/runtime/generated"],
    constraints: ["Do not modify files."],
  },
  allowedTools: ["read", "search"],
  contextPackage: {
    items: [
      {
        id: "user-request",
        kind: "request",
        source: "user",
        content: "Find workflow transition code.",
      },
    ],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["List matching files with evidence."],
  },
  evidenceRequirements: {
    requiredKinds: ["search_query", "search_match"],
    minimumCount: 2,
  },
  limits: {
    timeoutMs: 10_000,
    maxSteps: 8,
  },
};

const validResult: SubagentResult = {
  contractId: "search-related-files",
  role: "search-agent",
  status: "completed",
  summary: "Found the workflow runner.",
  evidence: [
    {
      kind: "search_query",
      source: "search",
      summary: "Searched for WorkflowTransition.",
    },
    {
      kind: "search_match",
      source: "src/runtime/workflow-types.ts",
      summary: "Defines WorkflowTransition.",
    },
  ],
  errors: [],
  extensions: {
    searchedPaths: ["src/runtime"],
  },
};

test("parses a bounded subagent contract and unified result", () => {
  assert.deepEqual(subagentContractSchema.parse(validContract), validContract);
  assert.deepEqual(subagentResultSchema.parse(validResult), validResult);
});

test("rejects invalid contract budgets, tools, context, and scope", () => {
  assert.equal(subagentContractSchema.safeParse({
    ...validContract,
    limits: { timeoutMs: 0, maxSteps: 1 },
  }).success, false);

  assert.equal(subagentContractSchema.safeParse({
    ...validContract,
    allowedTools: ["read", "read"],
  }).success, false);

  assert.equal(subagentContractSchema.safeParse({
    ...validContract,
    allowedTools: ["read", "execute"],
  }).success, false);

  assert.equal(subagentContractSchema.safeParse({
    ...validContract,
    scope: { ...validContract.scope, include: [] },
  }).success, false);

  assert.equal(subagentContractSchema.safeParse({
    ...validContract,
    contextPackage: { ...validContract.contextPackage, maxChars: 4 },
  }).success, false);
});

test("rejects free text, control decisions, and non-JSON extensions", () => {
  assert.equal(subagentResultSchema.safeParse("Found two files").success, false);

  assert.equal(subagentResultSchema.safeParse({
    ...validResult,
    transition: { type: "stop", status: "completed", reason: "done" },
  }).success, false);

  assert.equal(subagentResultSchema.safeParse({
    ...validResult,
    extensions: { callback: () => "not serializable" },
  }).success, false);
});

test("validates a completed result against its contract", () => {
  assert.deepEqual(validateSubagentResult(validContract, validResult), validResult);
});

test("rejects mismatched contract identity and role", () => {
  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    contractId: "another-contract",
  }));

  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    role: "reviewer-agent",
  }));
});

test("requires completed results to satisfy evidence requirements", () => {
  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    evidence: validResult.evidence.slice(0, 1),
  }));

  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    evidence: [
      validResult.evidence[0],
      { kind: "search_query", source: "search", summary: "Repeated query." },
    ],
  }));
});

test("keeps completed and unsuccessful error states consistent", () => {
  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    errors: [{ code: "unexpected", message: "Unexpected error", retryable: false }],
  }));

  for (const status of ["failed", "blocked", "timed_out"] as const) {
    assert.throws(() => validateSubagentResult(validContract, {
      ...validResult,
      status,
      errors: [],
    }));
  }
});

test("rejects evidence sourced outside contract scope", () => {
  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    evidence: [
      validResult.evidence[0],
      {
        kind: "search_match",
        source: "src/agents/create-agent.ts",
        summary: "This path is outside src/runtime.",
      },
    ],
  }));

  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    evidence: [
      validResult.evidence[0],
      {
        kind: "search_match",
        source: "src/runtime/generated/result.ts",
        summary: "This path is explicitly excluded.",
      },
    ],
  }));
});
