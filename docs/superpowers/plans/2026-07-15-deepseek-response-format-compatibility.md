# DeepSeek Response Format Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek Chat Completions 请求使用 `response_format.type = "json_object"`，同时保留 Agent 的 Zod 最终输出校验。

**Architecture:** 在 `OpenAIProvider` 与 Runner 之间增加一个只改写 model request 副本的 `ModelProvider` 包装器。包装器仅供 `chat_completions` 配置使用；它把 SDK 序列化出的 `json_schema` 输出标记替换为 Chat Completions adapter 能转换成 `json_object` 的兼容标记，其他字段、流式调用和重试建议都透明代理。

**Tech Stack:** TypeScript 7、ESM、`@openai/agents` 0.13、Node `node:test`、Zod 4。

## Global Constraints

- 使用严格 TypeScript、`.js` ESM import、双引号、两空格缩进和分号。
- 重要兼容逻辑添加详细中文注释，说明 provider 边界、数据流和类型边界。
- 不修改 GPT Responses、Shell 审批、trace schema 或 DeepSeek 配置。
- 不新增第三方依赖，不执行默认关闭的付费 live integration test。
- 保留工作区已有未提交改动，不暂存或覆盖无关文件。

---

### Task 1: DeepSeek model request 兼容包装器

**Files:**
- Create: `src/agents/providers/create-json-object-model-provider.ts`
- Create: `tests/unit/json-object-model-provider.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `Model`, `ModelRequest` from `@openai/agents`。
- Produces: `createJsonObjectModelProvider(delegate: ModelProvider): ModelProvider`。

- [ ] **Step 1: Write the failing tests**

新增测试，使用记录请求的 fake `Model`/`ModelProvider`，断言 `getResponse()` 和 `getStreamedResponse()` 接收到兼容副本：结构化输出的 `type` 不再是 `json_schema`，原始 request 保持不变；文本请求保持同一语义；`getRetryAdvice()` 透明代理。

- [ ] **Step 2: Run the focused test to verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/json-object-model-provider.test.ts`

Expected: FAIL，因为模块 `create-json-object-model-provider.js` 尚不存在。

- [ ] **Step 3: Implement the minimal wrapper**

实现内部 `JsonObjectModel`，复制结构化 request，并在局部、带解释的类型边界内把 `outputType` 转成非 `json_schema` 对象，使 SDK Chat Completions adapter 走现有 `json_object` 分支。代理非流式、流式和可选 retry advice；provider 的 `getModel()` 返回包装后的 delegate model。

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/json-object-model-provider.test.ts`

Expected: PASS，0 failures。

### Task 2: 只为 Chat Completions 启用兼容层

**Files:**
- Modify: `src/agents/providers/create-model-provider.ts`
- Modify: `tests/unit/agent-provider.test.ts`

**Interfaces:**
- Consumes: `createJsonObjectModelProvider(delegate)` from Task 1。
- Produces: `createModelProvider(modelConfig, apiKey): ModelProvider`；Responses 返回原始 `OpenAIProvider`，Chat Completions 返回兼容 provider。

- [ ] **Step 1: Write the failing provider-selection test**

扩展 provider 测试，断言 Responses 配置返回 `OpenAIProvider`，Chat Completions 配置返回兼容 wrapper；保留现有 options 映射断言。

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/agent-provider.test.ts tests/unit/json-object-model-provider.test.ts`

Expected: 新的 Chat Completions wrapper 断言 FAIL。

- [ ] **Step 3: Wire the wrapper into provider creation**

把 `createModelProvider` 返回类型放宽为 `ModelProvider`。先构造原始 `OpenAIProvider`；当 `modelConfig.api === "chat_completions"` 时用兼容 provider 包装，否则直接返回原 provider。

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/agent-provider.test.ts tests/unit/json-object-model-provider.test.ts`

Expected: PASS，0 failures。

### Task 3: 全量验证

**Files:**
- Verify only; no production changes expected.

**Interfaces:**
- Consumes: Tasks 1–2 的完整实现。
- Produces: 可复核的单测和 TypeScript build 证据。

- [ ] **Step 1: Run all offline unit tests**

Run: `npm test`

Expected: exit code 0，0 failures。

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`

Expected: exit code 0，无 TypeScript errors。

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff -- src/agents/providers tests/unit docs/superpowers/plans/2026-07-15-deepseek-response-format-compatibility.md`

Expected: `git diff --check` 无输出；diff 仅包含计划内改动和用户原有的相关未提交改动。
