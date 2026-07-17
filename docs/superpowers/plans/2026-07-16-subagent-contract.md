# 可校验 Subagent Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 TypeScript 和 Zod 定义受限、可校验、可由主 loop 消费的 subagent contract/result，并提供 search、test、reviewer 三个可导入示例。

**Architecture:** `src/domain/subagent-contract.ts` 是唯一 provider-neutral 协议边界，负责基础 schema、JSON-compatible 扩展数据和 contract/result 跨对象不变量。`src/subagents/examples/` 只提供角色专用 fixture 与 extension schema，不接入 Agents SDK、dispatcher、handoff 或 workflow 状态推进。

**Tech Stack:** TypeScript 7、Node.js 22、ESM、Zod 4、`node:test`、`node:assert/strict`。

## Global Constraints

- 使用 strict TypeScript、双引号、分号、两空格缩进和带 `.js` 后缀的 ESM import。
- 重要逻辑添加中文注释，解释设计意图、数据流、失败处理和边界条件。
- contract 保持 provider-neutral，不引用 `@openai/agents`。
- subagent 结果不得包含 `WorkflowTransition`、整体 stop reason 或 completion decision。
- `extensions` 只能保存 JSON-compatible object；主 loop 不依赖其中的角色专有字段。
- 本计划不实现真实调度、并发、handoff、模型调用、取消、重试、timeout 计时器或 step runner。
- 不运行付费 live integration。

## File Structure

- Create `src/domain/subagent-contract.ts`: 定义角色、工具、上下文、contract、统一 result、JSON value schema 和跨对象验证函数。
- Create `src/subagents/examples/search-agent-example.ts`: 定义 search-agent contract、有效 result 和专用 extension schema。
- Create `src/subagents/examples/test-agent-example.ts`: 定义 test-agent contract、有效 result 和专用 extension schema。
- Create `src/subagents/examples/reviewer-agent-example.ts`: 定义 reviewer-agent contract、有效 result 和专用 extension schema。
- Create `tests/unit/subagent-contract.test.ts`: 覆盖基础 schema、不变量、越权 evidence、三个示例和非 JSON 扩展。

---

### Task 1: 基础 Contract 与 Result Schema

**Files:**
- Create: `src/domain/subagent-contract.ts`
- Create: `tests/unit/subagent-contract.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvidence` 的结构约定 `{ kind: string; source: string; summary: string }`，但不把 runtime 模块引入 Zod schema。
- Produces: `SUBAGENT_ROLES`、`SUBAGENT_TOOLS`、`subagentContractSchema`、`subagentResultSchema`、`jsonObjectSchema`、`workspaceRelativePathSchema`、`SubagentContract`、`SubagentResult`、`JsonObject`。

- [ ] **Step 1: 写基础 schema 的失败测试**

创建 `tests/unit/subagent-contract.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试并确认它因模块不存在而失败**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: FAIL，错误包含 `Cannot find module '../../src/domain/subagent-contract.js'`。

- [ ] **Step 3: 实现基础类型和 schema**

创建 `src/domain/subagent-contract.ts`：

```ts
import { z } from "zod";

export const SUBAGENT_ROLES = [
  "search-agent",
  "test-agent",
  "reviewer-agent",
] as const;

export const SUBAGENT_TOOLS = ["read", "search", "test", "diff"] as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

function isWorkspaceRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || value.includes("//")) {
    return false;
  }

  const segments = value.split("/");
  return segments.length > 0 && segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export const workspaceRelativePathSchema = z.string().min(1).refine(
  isWorkspaceRelativePath,
  "Path must be a workspace-relative POSIX path without traversal",
);

const subagentContextItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  content: z.string(),
}).strict();

const subagentScopeSchema = z.object({
  include: z.array(workspaceRelativePathSchema).min(1),
  exclude: z.array(workspaceRelativePathSchema),
  constraints: z.array(z.string().min(1)),
}).strict();

const subagentExpectedOutputSchema = z.object({
  format: z.literal("subagent-result"),
  requirements: z.array(z.string().min(1)).min(1),
}).strict();

const subagentEvidenceRequirementsSchema = z.object({
  requiredKinds: z.array(z.string().min(1)).min(1),
  minimumCount: z.number().int().positive(),
}).strict();

export const subagentContractSchema = z.object({
  id: z.string().min(1),
  role: z.enum(SUBAGENT_ROLES),
  task: z.string().min(1),
  scope: subagentScopeSchema,
  allowedTools: z.array(z.enum(SUBAGENT_TOOLS)),
  contextPackage: z.object({
    items: z.array(subagentContextItemSchema),
    maxChars: z.number().int().positive(),
  }).strict(),
  expectedOutput: subagentExpectedOutputSchema,
  evidenceRequirements: subagentEvidenceRequirementsSchema,
  limits: z.object({
    timeoutMs: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((contract, context) => {
  if (new Set(contract.allowedTools).size !== contract.allowedTools.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedTools"],
      message: "allowedTools must not contain duplicates",
    });
  }

  const contextChars = contract.contextPackage.items.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  if (contextChars > contract.contextPackage.maxChars) {
    context.addIssue({
      code: "custom",
      path: ["contextPackage", "items"],
      message: "Context package exceeds maxChars",
    });
  }
});

const workflowEvidenceSchema = z.object({
  kind: z.string().min(1),
  source: z.string().min(1),
  summary: z.string().min(1),
}).strict();

const subagentErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export const subagentResultSchema = z.object({
  contractId: z.string().min(1),
  role: z.enum(SUBAGENT_ROLES),
  status: z.enum(["completed", "failed", "blocked", "timed_out"]),
  summary: z.string().min(1),
  evidence: z.array(workflowEvidenceSchema),
  errors: z.array(subagentErrorSchema),
  extensions: jsonObjectSchema.optional(),
}).strict();

export type SubagentRole = z.infer<typeof subagentContractSchema>["role"];
export type AllowedSubagentTool = z.infer<
  typeof subagentContractSchema
>["allowedTools"][number];
export type SubagentContextItem = z.infer<
  typeof subagentContractSchema
>["contextPackage"]["items"][number];
export type SubagentContract = z.infer<typeof subagentContractSchema>;
export type SubagentResult = z.infer<typeof subagentResultSchema>;
export type SubagentError = SubagentResult["errors"][number];
```

- [ ] **Step 4: 运行测试并确认基础 schema 通过**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: PASS，3 tests passed。

- [ ] **Step 5: 提交基础 schema**

```bash
git add src/domain/subagent-contract.ts tests/unit/subagent-contract.test.ts
git commit -m "feat: define subagent contract schemas"
```

---

### Task 2: Contract 与 Result 跨对象不变量

**Files:**
- Modify: `src/domain/subagent-contract.ts`
- Modify: `tests/unit/subagent-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `subagentContractSchema`、`subagentResultSchema`、`SubagentContract` 和 `SubagentResult`。
- Produces: `validateSubagentResult(contract: unknown, result: unknown): SubagentResult`；失败统一抛出 `ZodError`。

- [ ] **Step 1: 写跨对象校验的失败测试**

把以下 import 加入 `tests/unit/subagent-contract.test.ts` 的 domain import：

```ts
  validateSubagentResult,
```

在同一文件末尾添加：

```ts
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
```

- [ ] **Step 2: 运行测试并确认它因函数未导出而失败**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: FAIL，错误说明 `validateSubagentResult` 未从模块导出。

- [ ] **Step 3: 实现词法 scope 与跨对象校验**

在 `src/domain/subagent-contract.ts` 的类型导出之后添加：

```ts
function isSameOrChildPath(candidate: string, scopePath: string): boolean {
  const normalizedScope = scopePath.endsWith("/")
    ? scopePath.slice(0, -1)
    : scopePath;
  return candidate === normalizedScope || candidate.startsWith(`${normalizedScope}/`);
}

function isEvidenceSourceAllowed(
  contract: SubagentContract,
  source: string,
): boolean {
  const logicalSources = new Set([
    contract.id,
    ...contract.allowedTools,
    ...contract.contextPackage.items.map((item) => item.id),
  ]);
  if (logicalSources.has(source)) {
    return true;
  }

  if (!workspaceRelativePathSchema.safeParse(source).success) {
    return false;
  }

  const included = contract.scope.include.some(
    (scopePath) => isSameOrChildPath(source, scopePath),
  );
  const excluded = contract.scope.exclude.some(
    (scopePath) => isSameOrChildPath(source, scopePath),
  );
  return included && !excluded;
}

const subagentExecutionSchema = z.object({
  contract: subagentContractSchema,
  result: subagentResultSchema,
}).strict().superRefine(({ contract, result }, context) => {
  if (result.contractId !== contract.id) {
    context.addIssue({
      code: "custom",
      path: ["result", "contractId"],
      message: "Result contractId does not match the contract",
    });
  }

  if (result.role !== contract.role) {
    context.addIssue({
      code: "custom",
      path: ["result", "role"],
      message: "Result role does not match the contract",
    });
  }

  result.evidence.forEach((evidence, index) => {
    if (!isEvidenceSourceAllowed(contract, evidence.source)) {
      context.addIssue({
        code: "custom",
        path: ["result", "evidence", index, "source"],
        message: "Evidence source is outside the contract scope",
      });
    }
  });

  if (result.status === "completed") {
    if (result.errors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["result", "errors"],
        message: "Completed results cannot contain errors",
      });
    }

    if (result.evidence.length < contract.evidenceRequirements.minimumCount) {
      context.addIssue({
        code: "custom",
        path: ["result", "evidence"],
        message: "Completed result does not meet minimum evidence count",
      });
    }

    const evidenceKinds = new Set(result.evidence.map((item) => item.kind));
    for (const requiredKind of contract.evidenceRequirements.requiredKinds) {
      if (!evidenceKinds.has(requiredKind)) {
        context.addIssue({
          code: "custom",
          path: ["result", "evidence"],
          message: `Completed result is missing evidence kind: ${requiredKind}`,
        });
      }
    }
  } else if (result.errors.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["result", "errors"],
      message: "Unsuccessful results must contain a structured error",
    });
  }
});

export function validateSubagentResult(
  contract: unknown,
  result: unknown,
): SubagentResult {
  return subagentExecutionSchema.parse({ contract, result }).result;
}
```

- [ ] **Step 4: 运行测试并确认跨对象不变量通过**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: PASS，8 tests passed。

- [ ] **Step 5: 提交跨对象校验**

```bash
git add src/domain/subagent-contract.ts tests/unit/subagent-contract.test.ts
git commit -m "feat: validate subagent result invariants"
```

---

### Task 3: Search、Test、Reviewer 示例

**Files:**
- Create: `src/subagents/examples/search-agent-example.ts`
- Create: `src/subagents/examples/test-agent-example.ts`
- Create: `src/subagents/examples/reviewer-agent-example.ts`
- Modify: `tests/unit/subagent-contract.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `SubagentContract`、`SubagentResult`、`workspaceRelativePathSchema` 和 `validateSubagentResult()`。
- Produces: 三组 `<role>Contract`、`<role>Result`、`<role>ExtensionsSchema`，供未来 coordinator、文档和测试直接导入。

- [ ] **Step 1: 写三个示例的失败测试**

在 `tests/unit/subagent-contract.test.ts` 的 imports 后添加：

```ts
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
```

在同一文件末尾添加：

```ts
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
```

- [ ] **Step 2: 运行测试并确认它因示例模块不存在而失败**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: FAIL，错误包含 `Cannot find module` 和首个缺失的 example 文件路径。

- [ ] **Step 3: 实现 search-agent 示例**

创建 `src/subagents/examples/search-agent-example.ts`：

```ts
import { z } from "zod";

import {
  workspaceRelativePathSchema,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const searchAgentExtensionsSchema = z.object({
  matches: z.array(z.object({
    path: workspaceRelativePathSchema,
    line: z.number().int().positive(),
    summary: z.string().min(1),
  }).strict()),
  searchedPaths: z.array(workspaceRelativePathSchema).min(1),
}).strict();

export const searchAgentContract = {
  id: "search-workflow-transition",
  role: "search-agent",
  task: "Find the definitions and consumers of WorkflowTransition.",
  scope: {
    include: ["src/runtime"],
    exclude: [],
    constraints: ["Read and search only; do not modify files."],
  },
  allowedTools: ["read", "search"],
  contextPackage: {
    items: [{
      id: "search-request",
      kind: "request",
      source: "user",
      content: "Locate WorkflowTransition and explain each match.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return matched files and explicit search evidence."],
  },
  evidenceRequirements: {
    requiredKinds: ["search_query", "search_match"],
    minimumCount: 2,
  },
  limits: { timeoutMs: 10_000, maxSteps: 6 },
} satisfies SubagentContract;

export const searchAgentResult = {
  contractId: "search-workflow-transition",
  role: "search-agent",
  status: "completed",
  summary: "Found the transition type and runner consumer.",
  evidence: [
    {
      kind: "search_query",
      source: "search",
      summary: "Searched src/runtime for WorkflowTransition.",
    },
    {
      kind: "search_match",
      source: "src/runtime/workflow-types.ts",
      summary: "Defines the WorkflowTransition discriminated union.",
    },
    {
      kind: "search_match",
      source: "src/runtime/run-workflow.ts",
      summary: "Consumes next and stop transitions.",
    },
  ],
  errors: [],
  extensions: {
    matches: [
      {
        path: "src/runtime/workflow-types.ts",
        line: 9,
        summary: "WorkflowTransition type definition.",
      },
      {
        path: "src/runtime/run-workflow.ts",
        line: 100,
        summary: "Workflow transition routing.",
      },
    ],
    searchedPaths: ["src/runtime"],
  },
} satisfies SubagentResult;
```

- [ ] **Step 4: 实现 test-agent 示例**

创建 `src/subagents/examples/test-agent-example.ts`：

```ts
import { z } from "zod";

import {
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const testAgentExtensionsSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  failedTests: z.array(z.string().min(1)),
}).strict();

export const testAgentContract = {
  id: "test-workflow-runner",
  role: "test-agent",
  task: "Run the narrow workflow runner unit test and summarize its result.",
  scope: {
    include: ["tests/unit", "src/runtime"],
    exclude: [],
    constraints: ["Do not edit source or test files."],
  },
  allowedTools: ["read", "search", "test"],
  contextPackage: {
    items: [{
      id: "test-request",
      kind: "request",
      source: "user",
      content: "Check the workflow runner unit tests.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return the exact command, exit code, and failed test names."],
  },
  evidenceRequirements: {
    requiredKinds: ["test_command", "test_result"],
    minimumCount: 2,
  },
  limits: { timeoutMs: 30_000, maxSteps: 8 },
} satisfies SubagentContract;

export const testAgentResult = {
  contractId: "test-workflow-runner",
  role: "test-agent",
  status: "completed",
  summary: "The workflow runner unit tests passed.",
  evidence: [
    {
      kind: "test_command",
      source: "test",
      summary: "Ran ./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts.",
    },
    {
      kind: "test_result",
      source: "test",
      summary: "Process exited with code 0 and reported no failed tests.",
    },
  ],
  errors: [],
  extensions: {
    command: "./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts",
    exitCode: 0,
    failedTests: [],
  },
} satisfies SubagentResult;
```

- [ ] **Step 5: 实现 reviewer-agent 示例**

创建 `src/subagents/examples/reviewer-agent-example.ts`：

```ts
import { z } from "zod";

import {
  workspaceRelativePathSchema,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const reviewerAgentExtensionsSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]),
    file: workspaceRelativePathSchema,
    line: z.number().int().positive(),
    title: z.string().min(1),
    rationale: z.string().min(1),
  }).strict()),
  reviewedFiles: z.array(workspaceRelativePathSchema).min(1),
}).strict();

export const reviewerAgentContract = {
  id: "review-workflow-runner",
  role: "reviewer-agent",
  task: "Review the supplied workflow runner diff for actionable defects.",
  scope: {
    include: ["src/runtime", "tests/unit"],
    exclude: [],
    constraints: ["Report evidence-backed findings; do not edit files."],
  },
  allowedTools: ["read", "search", "diff"],
  contextPackage: {
    items: [{
      id: "review-diff",
      kind: "git-diff",
      source: "git",
      content: "Review the current diff affecting src/runtime/run-workflow.ts.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return located findings or an explicit empty findings list."],
  },
  evidenceRequirements: {
    requiredKinds: ["review_scope"],
    minimumCount: 1,
  },
  limits: { timeoutMs: 15_000, maxSteps: 8 },
} satisfies SubagentContract;

export const reviewerAgentResult = {
  contractId: "review-workflow-runner",
  role: "reviewer-agent",
  status: "completed",
  summary: "Reviewed the scoped files and found no actionable defects.",
  evidence: [{
    kind: "review_scope",
    source: "review-diff",
    summary: "Reviewed run-workflow implementation and its unit tests.",
  }],
  errors: [],
  extensions: {
    findings: [],
    reviewedFiles: [
      "src/runtime/run-workflow.ts",
      "tests/unit/workflow-runner.test.ts",
    ],
  },
} satisfies SubagentResult;
```

- [ ] **Step 6: 运行示例测试并确认全部通过**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/subagent-contract.test.ts
```

Expected: PASS，10 tests passed。

- [ ] **Step 7: 运行 TypeScript build，确认示例满足统一类型**

Run:

```bash
npm run build
```

Expected: PASS，`tsc -p tsconfig.json` exit code 0。

- [ ] **Step 8: 提交三个示例**

```bash
git add src/subagents/examples/search-agent-example.ts src/subagents/examples/test-agent-example.ts src/subagents/examples/reviewer-agent-example.ts tests/unit/subagent-contract.test.ts
git commit -m "feat: add bounded subagent examples"
```

---

## Final Verification

- [ ] 运行全部离线单元测试：

```bash
npm test
```

Expected: PASS，所有 `tests/unit/*.test.ts` 通过。

- [ ] 运行完整 TypeScript build：

```bash
npm run build
```

Expected: PASS，`tsc -p tsconfig.json` exit code 0。

- [ ] 检查空白错误：

```bash
git diff --check
```

Expected: exit code 0，且没有输出。

- [ ] 检查变更范围：

```bash
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: feature commits 只包含本计划列出的 domain、example 和 unit test 文件；已有的无关未跟踪文件保持未暂存、未修改。
