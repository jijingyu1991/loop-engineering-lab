import assert from "node:assert/strict";
import { test } from "node:test";

import {
  subagentContractSchema,
  subagentResultSchema,
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
