# loop-engineering-lab

一个用于学习 Agent Loop 工程化的最小 TypeScript 项目。它刻意把 Loop
协议、模型调用和 trace 存储拆开，方便逐层阅读，也方便后续把骨架阶段替换成
真正的 planner、reviewer、tools 和 guardrails。

## 当前实现

每一轮 `LoopStep` 固定执行七个阶段：

```text
observe → orient → plan → act → verify → reflect → stop
```

- `observe` 从 task 和上一轮结果构造上下文。
- `orient` 当前使用明确标记的 skeleton 数据。
- `plan` 当前生成简单动作和“三轮完成”的业务停止条件。
- `act` 使用 OpenAI Agents SDK 调用真实 GPT 或 DeepSeek API。
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
更早的 `loop-*.jsonl` 会自动删除；`.gitkeep` 和其他文件不会被清理。每一行都是
独立 JSON 事件，可以看到：

- Loop 启动时的 task 和逻辑模型名；
- 每轮七个阶段的 started/completed/failed/skipped 顺序；
- 阶段数据来自 runtime、agent 还是 skeleton；
- 最终状态、完成轮数和停止原因。

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
2. `src/loop/run-loop-step.ts`：理解一轮如何按顺序执行、失败时如何 skip。
3. `src/loop/loop-runner.ts`：理解外层循环和终态写入。
4. `src/loop/stages/stop.ts`：理解业务成功与安全限制的优先级。
5. `src/agents/`：理解配置如何变成 Agents SDK provider、runner 和 Agent。
6. `src/trace/`：理解 append-only JSONL trace。
7. `src/cli.ts`：理解配置、Agent、Loop 和 trace 如何在入口处组装。

未来添加 tools 和 guardrails 时放在 `src/agents/tools/` 与
`src/agents/guardrails/`；`act` 只消费组装完成的 Agent，LoopRunner 不需要改变。
