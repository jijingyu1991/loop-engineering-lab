# loop-engineering-lab

一个用于学习 Agent Loop 工程化的最小 TypeScript 项目。它刻意把 Loop
协议、模型调用和 trace 存储拆开，方便逐层阅读，也方便后续把骨架阶段替换成
真正的 planner、reviewer、tools 和 guardrails。

## 当前实现

每一轮 `LoopStep` 当前由各阶段返回的 `StepDecision` 形成以下默认路径：

```text
observe → orient → plan → act → verify → reflect → stop
```

阶段会同时返回业务数据和下一阶段决策，例如 plan 返回
`{ nextStep: "act", reason: "plan_completed" }`。`runLoopStep` 只负责执行决策，
因此未来可以在阶段内部升级为条件跳转，而不需要重写协调器。

- `observe` 从 task 和上一轮结果构造上下文。
- `orient` 当前使用明确标记的 skeleton 数据。
- `plan` 当前生成简单动作和“三轮完成”的业务停止条件。
- `act` 使用 OpenAI Agents SDK 调用真实 GPT 或 DeepSeek API，并可调用 workspace
  文件、搜索和 shell 工具。
- `verify` 当前是 skeleton verifier：第 3 轮才满足 plan 条件。
- `reflect` 当前生成供下一轮使用的简单反馈。
- `stop` 汇总 verify、执行错误和安全限制，决定继续、成功或失败。

代码中的 `source: "runtime" | "agent" | "skeleton"` 会明确说明每个阶段的
数据来源，避免把临时骨架误认为真实 Agent 推理。

## 安装

要求 Node.js 22 或更新版本。

```bash
npm install
```

## 配置 API Key

项目已经生成本地 `.env`，它被 `.gitignore` 排除，不会进入 Git。填写要使用的
模型对应的 Key：

```dotenv
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

不要把真实 Key 写入 `config/loop.config.json`、测试、trace 或提交记录。

## 切换 GPT 与 DeepSeek

编辑 `config/loop.config.json` 中的逻辑名称：

```json
{
  "activeModel": "gpt"
}
```

可用值：

- `gpt`：`gpt-5.4-mini`，`https://api.openai.com/v1`，Responses API。
- `deepseek`：`deepseek-v4-flash`，`https://api.deepseek.com`，Chat Completions API。

模型名、`baseURL`、API 类型和 Key 环境变量都在同一个配置表中。业务代码只读取
`activeModel`，因此切换模型不需要修改 TypeScript。

## 本地工具与 workspace 权限

三个本地工具共享 `config/loop.config.json` 中的 `tools.workspaceRoot`。该字段可配置，
缺省为启动进程的当前目录；相对值也基于当前目录解析。文件路径、搜索根目录和 shell
cwd 都必须位于这个 workspace 内。`..`、绝对路径和指向 workspace 外的符号链接都会
被拒绝，用户批准 shell 命令也不能扩大这个硬边界。

- `workspace_file`：读取 UTF-8 文件，或原子写入文件；覆盖已有文件必须显式设置
  `overwrite: true`。
- `workspace_search`：使用 ripgrep 搜索 literal 或 regex；无匹配是成功空数组。
- `workspace_shell`：只接受 `executable`、`args[]` 和相对 `cwd`，使用
  `spawn(..., { shell: false })`，不解析管道、重定向或命令替换。

shell 权限按 `{ executable, argsPrefix }` 匹配：

- `allowedExecutables` 中的规则可以直接执行；
- `approvalRequiredExecutables` 中的规则会暂停 Agent，在当前终端请求批准；
- 未匹配任何规则的命令返回 `command_not_allowed`。

例如 `git status` 默认允许，`git push ...` 默认需要批准。命令行会把提示写到 stderr：

```text
Shell approval required
cwd: .
command: git push origin main
Allow this call? [y/N]
```

只有 `y` 或 `yes`（忽略大小写）表示批准；其他输入和 EOF 默认拒绝。非 TTY 环境不会
阻塞，而是向 Agent 返回 `approval_required`，建议在交互式终端重跑。

## 统一工具错误 contract

工具失败是模型可见的 JSON 值，不是裸 stderr：

```json
{
  "ok": false,
  "error": {
    "type": "timeout",
    "message": "The command exceeded the configured timeout.",
    "retryable": true,
    "userActionRequired": false,
    "suggestedNextStep": "Retry once or narrow the command workload.",
    "evidence": {
      "tool": "shell",
      "operation": "execute",
      "durationMs": 10000
    }
  }
}
```

`retryable` 表示不改变输入、无需用户介入，再执行一次可能成功。工具内部不会自动重试；
Agent 根据该字段和 evidence 决定下一步，避免隐藏文件写入或命令执行的重复副作用。

## 运行 Loop

```bash
npm run loop -- "把这段需求逐轮改写得更清晰"
```

CLI 最终会输出：

```json
{
  "status": "completed",
  "stopReason": "plan_condition_met",
  "completedSteps": 3,
  "finalOutput": "..."
}
```

每次运行都会生成独立文件，例如
`traces/loop-2026-07-13T08-30-00-123Z.jsonl`。目录只保留最新 20 次运行，
更早的 `loop-*.jsonl` 会自动删除；`.gitkeep` 和其他文件不会被清理。旧版本的
聚合文件 `traces/loop.jsonl` 会在首次运行新版本时删除，避免它绕过“最近 20 次
运行”的限制。每个新文件都由独立 JSON 事件组成，可以看到：

- Loop 启动时的 task 和逻辑模型名；
- 每轮七个阶段的 started/completed/failed/skipped 顺序；
- 阶段数据来自 runtime、agent 还是 skeleton；
- 每次工具调用的 `tool_started`、`tool_completed` 或 `tool_failed`；
- shell 的 `tool_approval_requested` 与 `tool_approval_resolved`；
- 工具失败时完整的 type、retryable、userActionRequired、suggestedNextStep 和 evidence；
- 最终状态、完成轮数和停止原因。

## Coding mode

在普通 Loop 任务前加入 `coding` 子命令，就会进入面向代码库阅读与诊断的只读
workflow：

```bash
npm run loop -- coding "帮我查看 loop 模块代码"
npm run loop -- coding "帮我查找 trace 相关文件"
npm run loop -- coding "帮我诊断 npm test 的失败"
npm run loop -- coding "帮我实现一个 login 页面"
```

Coding mode 会先把自然语言请求分类为三个核心任务类型：

- `explain_module`：读取相关代码，以仓库证据解释职责、入口、依赖、数据流和失败边界；
- `find_related_files`：搜索并按关系整理相关文件，无匹配时返回明确的空结果；
- `diagnose_test_failure`：运行范围尽可能小的测试、检查失败证据，并给出根因假设和下一步。

当请求要求实现、修改或新增功能时，当前里程碑不会写代码，而是回退到
`propose_implementation_plan`：它仍会执行一次只读 workflow，结合仓库约定给出可能涉及
的文件、实施步骤、测试和风险，并明确说明 `No files were modified.`。Coding mode 目前只向
Agent 暴露文件读取、workspace 搜索和经过权限检查的 shell 工具，不暴露文件编辑能力，
因此包括 implementation-plan fallback 在内的所有路径都不会修改文件。

命令结束时会输出结构化结果，字段含义如下：

- `status`：运行终态，例如 `completed`、`failed` 或 `blocked`；
- `taskType`：分类得到的 Coding 任务类型；分类失败时为 `null`；
- `stopReason`：workflow 停止原因；
- `completedSteps`：实际完成的 workflow 步骤数；
- `finalOutput`：Agent 的最终文本；没有可返回输出时为 `null`；
- `tracePath`：本次运行对应的 JSONL trace 文件路径。

四种成功停止原因分别是 `explanation_completed`、`related_files_identified`、
`diagnosis_completed` 和 `implementation_plan_completed`，与上述四条执行路径一一对应。
每次 Coding mode 运行都会创建自己的结构化 JSONL trace，记录分类、workflow step、证据、
transition 和最终终态，便于独立审计一次运行而不与其他任务混合。

## 两种“最大次数”

配置中有两个容易混淆、但作用完全不同的安全限制：

- `maxSteps`：最多执行多少个完整的七阶段 `LoopStep`。
- `maxTurns`：单次 `act` 内部，Agents SDK 最多允许多少轮模型/tool/handoff 往返。

`maxTurns` 超限会得到失败原因 `max_turns_exceeded`。如果 plan 的业务条件一直
没有满足，达到 `maxSteps` 会得到 `max_steps_exceeded`。两者都只是防失控的安全
限制；正常成功由 plan 产生的条件经过 verify 后得到 `plan_condition_met`。

## 测试

不联网的单元测试：

```bash
npm test
```

TypeScript 构建：

```bash
npm run build
```

默认运行集成测试时，真实 API case 会安全跳过：

```bash
npm run test:integration
```

填写当前模型对应的 Key 后，显式启用真实 API 验收：

```bash
RUN_LIVE_LOOP=1 npm run test:integration
```

真实验收会执行三个 `act` API 调用，检查三轮 LoopStep、Agent 输出和最终
`plan_condition_met`。

## 代码阅读顺序

建议按以下顺序学习：

1. `src/domain/loop-step.ts`：理解 LoopStep 和七阶段数据结构。
2. `src/loop/run-loop-step.ts`：理解一轮如何消费阶段决策、失败时如何 skip。
3. `src/loop/loop-runner.ts`：理解外层循环和终态写入。
4. `src/loop/stages/stop.ts`：理解业务成功与安全限制的优先级。
5. `src/agents/tools/`：理解统一 ToolResult、workspace guard、权限与三个工具。
6. `src/agents/`：理解配置如何变成 Agents SDK provider、runner 和 Agent。
7. `src/trace/`：理解 append-only JSONL trace。
8. `src/cli.ts`：理解配置、Agent、Loop、tools 和 trace 如何在入口处组装。

未来添加 guardrails 时放在 `src/agents/guardrails/`；`act` 只消费组装完成的 Agent，
LoopRunner 不需要理解具体工具实现。
