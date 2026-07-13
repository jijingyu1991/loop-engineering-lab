# Repository Guidelines and Chinese Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增仓库贡献者指南，并将源码与测试中已有的人工英文注释翻译为详细、准确的中文注释。

**Architecture:** 本次变更仅涉及文档和注释，不改变程序接口或运行时行为。`AGENTS.md` 从现有目录、npm scripts、TypeScript 配置和 Git 历史提炼规则；注释采用逐条人工翻译，保留必要技术术语。

**Tech Stack:** Markdown、TypeScript 7、Node.js 22、`tsx`、Node.js test runner

## Global Constraints

- `AGENTS.md` 标题必须为 “Repository Guidelines”，正文以 200–400 词为目标。
- 本仓库是学习项目；关键逻辑必须提供详细中文注释，解释设计原因、数据流、错误处理和边界条件。
- 只翻译 `src/**/*.ts` 与 `tests/**/*.ts` 中已有的人工英文注释。
- 不修改 `dist/`、依赖、历史文档、配置数据、字符串字面量、标识符或程序行为。
- 保留 `LoopStep`、`Agent`、trace、JSONL、SDK、API 等必要技术术语。

---

### Task 1: 新增仓库贡献者指南

**Files:**
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: `package.json` scripts、`README.md` 结构说明、`tsconfig.json` 编译规则、Git 提交历史
- Produces: 仓库根目录贡献规范，供后续贡献者和 agent 使用

- [ ] **Step 1: 写入完整指南**

```markdown
# Repository Guidelines

## Project Structure & Module Organization

`src/cli.ts` is the composition root. Domain types live in `src/domain/`, loop orchestration in `src/loop/`, model setup in `src/agents/`, configuration in `src/config/`, and JSONL tracing in `src/trace/`. Stage implementations are under `src/loop/stages/`. Unit tests belong in `tests/unit/`; opt-in API tests belong in `tests/integration/`. Runtime configuration is stored in `config/loop.config.json`; generated output goes to `dist/` and local traces to `traces/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 22 or newer is required.
- `npm run loop -- "任务描述"`: run the configured loop locally.
- `npm test`: run offline unit tests with `tsx` and Node's test runner.
- `npm run build`: type-check and compile TypeScript into `dist/`.
- `npm run test:integration`: run integration tests; live API work is skipped by default.
- `RUN_LIVE_LOOP=1 npm run test:integration`: perform the paid, credentialed live check.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports ending in `.js`, two-space indentation, double quotes, and semicolons. Prefer `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case filenames such as `create-run-trace-writer.ts`. Keep domain code provider-neutral and isolate filesystem or SDK concerns in adapters. No formatter or linter is configured, so match surrounding code and verify with `npm run build`.

This is a learning project. Add detailed Chinese comments around important logic. Explain design intent, data flow, failure handling, and boundary conditions; do not merely restate each line. Keep established technical terms such as `LoopStep`, Agent, trace, JSONL, SDK, and API when they improve precision.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `<subject>.test.ts`. Put deterministic behavior in unit tests and network-dependent behavior in integration tests. Cover success paths, invalid input, failures, and safety limits. Run unit tests and the build before submitting; run the live integration check only when credentials and paid API usage are intended.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat:`, `fix:`, `docs:`, and `chore:`. Use an imperative, specific subject, for example `docs: add contributor guidelines`. Pull requests should explain motivation and behavior, list verification commands, link related issues, and call out configuration or API-cost effects. Include screenshots only for visual changes. Keep generated files, traces, and secrets out of commits.

## Security & Configuration Tips

Store credentials only in the ignored `.env` file. Never place real keys in config, tests, traces, logs, or commit history. Treat trace data as potentially sensitive before sharing it.
```

- [ ] **Step 2: 验证标题、结构和篇幅**

Run: `sed -n '1,260p' AGENTS.md && wc -w AGENTS.md`

Expected: 标题为 `# Repository Guidelines`，包含项目专用路径和命令，英文单词数在 200–400 之间。

### Task 2: 将人工英文注释翻译为中文

**Files:**
- Modify: `src/agents/create-agent.ts`
- Modify: `src/agents/create-runner.ts`
- Modify: `src/agents/disable-sdk-tracing.ts`
- Modify: `src/agents/providers/create-model-provider.ts`
- Modify: `src/cli.ts`
- Modify: `src/config/config-schema.ts`
- Modify: `src/config/load-config.ts`
- Modify: `src/domain/loop-state.ts`
- Modify: `src/domain/loop-step.ts`
- Modify: `src/domain/stage-result.ts`
- Modify: `src/domain/stop-decision.ts`
- Modify: `src/loop/create-loop-state.ts`
- Modify: `src/loop/loop-runner.ts`
- Modify: `src/loop/run-loop-step.ts`
- Modify: `src/loop/stages/act.ts`
- Modify: `src/loop/stages/observe.ts`
- Modify: `src/loop/stages/orient.ts`
- Modify: `src/loop/stages/plan.ts`
- Modify: `src/loop/stages/reflect.ts`
- Modify: `src/loop/stages/stop.ts`
- Modify: `src/loop/stages/verify.ts`
- Modify: `src/trace/create-run-trace-writer.ts`
- Modify: `src/trace/jsonl-trace-writer.ts`
- Modify: `tests/integration/live-loop.test.ts`

**Interfaces:**
- Consumes: 现有英文 JSDoc 与行注释
- Produces: 语义等价的中文学习注释；TypeScript AST 和运行时输出保持不变

- [ ] **Step 1: 翻译架构边界与配置注释**

在 `src/agents/`、`src/config/` 和 `src/cli.ts` 中使用以下明确表述：Agent 构造与 loop 隔离，以便以后添加 tools/guardrails；SDK 全局 trace 与本地 JSONL trace 相互独立；API 类型由配置显式指定；API key 不进入可追踪的 `LoopConfig`；文件系统访问只保留在配置适配器；CLI 是唯一了解具体基础设施的组合入口。

示例目标注释：

```ts
/**
 * Agent 的构造与 loop 隔离。以后可以在这里添加 tools 和 guardrails，
 * 而不必让 `loop-runner.ts` 理解 Agents SDK 的概念。
 */
```

- [ ] **Step 2: 翻译领域模型与 loop 生命周期注释**

在 `src/domain/` 与 `src/loop/` 中准确说明：`StageResult` 的统一生命周期外壳、`LoopStep` 与单次模型请求的区别、停止决策联合类型的约束、时间戳注入带来的可测试性、阶段执行顺序、终态持久化顺序，以及 stop 阶段的失败/业务成功/安全兜底优先级。

示例目标注释：

```ts
/**
 * 一个 `LoopStep` 表示一次完整的、受 OODA 启发的迭代，而不是一次模型请求。
 * 当前只有 `act` 会调用模型，但这些类型化阶段槽位允许未来用 planner 或
 * reviewer Agent 替换骨架阶段，而不必修改外层 runner。
 */
```

- [ ] **Step 3: 翻译阶段、trace 与集成测试注释**

在 `src/loop/stages/`、`src/trace/` 和 `tests/integration/live-loop.test.ts` 中说明：骨架阶段与真实 Agent 的边界、`maxTurns`/`maxSteps` 区别、JSONL 追加写入的审计价值、trace 保留与旧文件迁移策略，以及真实 API 测试默认跳过的成本与凭据原因。

示例目标注释：

```ts
/**
 * 真实测试必须显式启用，因为它会消耗付费 API token，并且需要有效凭据。
 * 单元测试会在不联网的情况下覆盖全部编排逻辑；这个检查点用于证明当前
 * 选中的 provider 能够端到端工作。
 */
```

- [ ] **Step 4: 扫描残留英文注释**

Run: `rg -n --glob '*.ts' '(^|[^:])//|/\\*|\\*/' src tests`

Expected: 所有匹配到的人工自然语言注释均为中文；技术术语可以保留英文。测试名称、prompt、错误消息和其他字符串不在翻译范围内。

### Task 3: 验证行为未改变

**Files:**
- Verify only: `src/**/*.ts`
- Verify only: `tests/**/*.ts`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的文档/注释改动
- Produces: 构建和测试证据

- [ ] **Step 1: 运行离线单元测试**

Run: `npm test`

Expected: 所有单元测试通过，无失败或跳过。

- [ ] **Step 2: 运行 TypeScript 构建**

Run: `npm run build`

Expected: `tsc -p tsconfig.json` 退出码为 0。

- [ ] **Step 3: 运行默认集成测试**

Run: `npm run test:integration`

Expected: 命令退出码为 0；真实 API case 因未设置 `RUN_LIVE_LOOP=1` 而跳过。

- [ ] **Step 4: 审查最终差异**

Run: `git diff --check && git diff -- AGENTS.md src tests`

Expected: 无空白错误；差异只包含新指南与注释文本，不包含代码逻辑或运行时字符串变化。
