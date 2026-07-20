import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";

import {
  subagentContractSchema,
  subagentResultSchema,
  validateSubagentResult,
  workspaceRelativePathSchema,
  type SubagentContract,
  type SubagentResult,
} from "../../src/domain/subagent-contract.js";
import {
  searchAgentContract,
  searchAgentExtensionsSchema,
  searchAgentResult,
} from "../../src/subagents/examples/search-agent-example.js";
import {
  testAgentContract,
  testAgentExtensionsSchema,
  testAgentResult,
} from "../../src/subagents/examples/test-agent-example.js";
import {
  reviewerAgentContract,
  reviewerAgentExtensionsSchema,
  reviewerAgentResult,
} from "../../src/subagents/examples/reviewer-agent-example.js";

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
  const parsedResult = subagentResultSchema.parse(validResult);
  assert.deepEqual(parsedResult, validResult);
  assert.notEqual(parsedResult.extensions, validResult.extensions);
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

test("validates workspace-relative POSIX path boundaries", () => {
  assert.equal(
    workspaceRelativePathSchema.safeParse("src/runtime/nested/file.ts").success,
    true,
  );

  const invalidPaths = [
    ["absolute", "/src/runtime/file.ts"],
    ["traversal", "src/runtime/../file.ts"],
    ["dot segment", "src/./runtime/file.ts"],
    ["repeated separator", "src//runtime/file.ts"],
    ["backslash", "src\\runtime\\file.ts"],
    ["trailing separator", "src/runtime/"],
    ["NUL", "src/runtime\0/file.ts"],
  ] as const;

  for (const [boundary, path] of invalidPaths) {
    assert.equal(
      workspaceRelativePathSchema.safeParse(path).success,
      false,
      `${boundary} path should be rejected`,
    );
  }
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

  assert.equal(subagentResultSchema.safeParse({
    ...validResult,
    extensions: { sparse: new Array(1) },
  }).success, false);
});

test("rejects cyclic and excessively nested extensions as Zod errors", () => {
  const cyclicExtensions: Record<string, unknown> = {};
  cyclicExtensions.self = cyclicExtensions;
  const cyclicResult = { ...validResult, extensions: cyclicExtensions };

  assert.equal(subagentResultSchema.safeParse(cyclicResult).success, false);
  assert.throws(
    () => validateSubagentResult(validContract, cyclicResult),
    ZodError,
  );

  let excessivelyNested: Record<string, unknown> = {};
  for (let depth = 0; depth < 101; depth += 1) {
    excessivelyNested = { nested: excessivelyNested };
  }

  const nestedResult = { ...validResult, extensions: excessivelyNested };
  assert.equal(subagentResultSchema.safeParse(nestedResult).success, false);
  assert.throws(
    () => validateSubagentResult(validContract, nestedResult),
    ZodError,
  );
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

  assert.throws(() => validateSubagentResult(validContract, {
    ...validResult,
    evidence: [
      validResult.evidence[0],
      {
        kind: "search_match",
        source: "src/runtime-old/file.ts",
        summary: "A shared string prefix is not an include-path match.",
      },
    ],
  }));
});

test("exports three main-loop-consumable subagent examples", () => {
  assert.deepEqual(
    validateSubagentResult(searchAgentContract, searchAgentResult),
    searchAgentResult,
  );
  assert.deepEqual(
    validateSubagentResult(testAgentContract, testAgentResult),
    testAgentResult,
  );
  assert.deepEqual(
    validateSubagentResult(reviewerAgentContract, reviewerAgentResult),
    reviewerAgentResult,
  );

  // reviewer 的事实来源被限制为冻结 trace 与 executor summary，且没有任何工具能力。
  // 这条 fixture 断言防止示例未来重新引入读取仓库、搜索或执行工具的越权行为。
  assert.deepEqual(reviewerAgentContract.allowedTools, []);
  assert.deepEqual(reviewerAgentContract.scope.include, ["traces"]);
  assert.deepEqual(
    reviewerAgentContract.contextPackage.items.map((item) => item.id),
    ["coding-trace", "executor-summary"],
  );
});

test("validates each example's role-specific extensions", () => {
  assert.deepEqual(
    searchAgentExtensionsSchema.parse(searchAgentResult.extensions),
    searchAgentResult.extensions,
  );
  assert.deepEqual(
    testAgentExtensionsSchema.parse(testAgentResult.extensions),
    testAgentResult.extensions,
  );
  assert.deepEqual(
    reviewerAgentExtensionsSchema.parse(reviewerAgentResult.extensions),
    reviewerAgentResult.extensions,
  );
});
