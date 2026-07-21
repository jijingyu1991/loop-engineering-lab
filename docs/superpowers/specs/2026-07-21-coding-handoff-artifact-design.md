# Coding Handoff Artifact Design

## Goal

在每次 Coding mode 运行进入终态后，自动在 workspace 根目录生成
`handoff.md`。新 Agent 或人类只阅读该文件，就能理解目标、当前进展、关键证据、
失败信息和下一步行动，而不必先通读 JSONL trace。

该能力仅适用于 Coding mode。`completed`、`failed`、`blocked` 和 `cancelled`
四种终态都必须生成 handoff。

## Design Principles

- handoff 是结构化运行状态的确定性投影，不发起额外模型调用。
- handoff 只承载交接所需的可行动信息；JSONL trace 继续承载完整审计记录。
- 固定 Markdown 结构和明确的压缩上限保证输出稳定、简短且可测试。
- handoff 写入采用原子替换，失败时不得破坏上一份完整文件。
- 不复制 API key、环境变量、原始 prompt、shell stdout/stderr 或完整模型响应。

## Architecture

新增独立的 `src/handoff/` 模块，并按职责分成三层：

1. Builder 从原始 Coding request、`CodingRunResult` 和本次运行的冻结 trace
   构造结构化 `HandoffArtifact`。
2. Renderer 把 `HandoffArtifact` 转换为固定七段 Markdown，不读取运行时资源。
3. Writer 使用同目录临时文件和 `rename` 原子覆盖 workspace 根目录的
   `handoff.md`。

`runConfiguredCodingMode()` 是接入点。它等待 `runCodingMode()` 写完 terminal trace，
取得 `RecordingTraceWriter` 的最终快照，然后构建、渲染并写入 handoff。classifier、
executor、reviewer 和通用 workflow runner 均无需知道 handoff 的文件格式。

每次运行覆盖上一份 `handoff.md`，因此该文件始终代表最近一次 Coding mode 运行。
每次运行的完整历史仍由独立 JSONL trace 保存。

## Artifact Contract

`HandoffArtifact` 使用明确字段表达七个固定区块：

- `goal`: 原始 Coding request。
- `currentState`: 终态 status、task type、stop reason、已完成 workflow 步数和精简后的
  final output。
- `completedSteps`: 从 `workflow_step_completed` 事件提取的成功步骤及其可行动 evidence。
- `openQuestions`: 当终态为 `blocked + user_action_required` 时保存 final output 中的
  用户问题；其他情况为空。
- `evidence`: 从结构化 workflow evidence 提取的 `kind`、`source` 和 `summary`。
- `failedAttempts`: 从 `tool_failed`、`workflow_step_failed`、reviewer revise、reviewer
  失败或超时等事件提取失败类型、简短原因和可用建议。
- `nextRecommendedAction`: 按终态和最具体失败确定性生成的下一步。

Renderer 固定输出以下标题，缺少内容的列表统一输出 `None recorded.`：

```markdown
# Task Handoff

## Goal
## Current State
## Completed Steps
## Open Questions
## Evidence
## Failed Attempts
## Next Recommended Action
```

## Extraction and Compaction Rules

所有自由文本先折叠多余空白，再应用以下上限：

- Goal：2,000 字符。
- Current State 中的 final output：2,000 字符。
- Completed Steps：最多 10 条。
- Open Questions：最多 5 条。
- Evidence：最多 10 条，每条最多 300 字符。
- Failed Attempts：最多 5 条，每条最多 300 字符。
- Next Recommended Action：最多 500 字符。

被截断的文本统一以 `… [truncated]` 结尾。结构化 evidence 按
`kind + source + summary` 去重。Completed Steps 按首次成功完成顺序保留；失败信息按
时间倒序选择较新的条目。Evidence 优先选择最终成功 attempt 的 workflow completion
evidence，再补充其他已完成步骤的 evidence，直到达到上限。

Builder 不读取或转录原始工具输入、工具 stdout/stderr、完整 prompt、完整 trace event
JSON 或环境变量。路径若已经存在于结构化 evidence 的 `source` 或 `summary` 中则保留，
使接手者可以直接复核仓库文件或 trace 文件。

## Next-Action Rules

- `blocked + user_action_required`：建议回答 `Open Questions` 中的第一个问题后重跑任务。
- 其他 `blocked`：建议解除 stop reason 指明的外部阻塞后重跑。
- `failed`：优先根据最新 failed attempt 的 suggested next step 行动；若不存在明确建议，
  则修复 stop reason 指明的问题后重跑。
- `cancelled`：确认目标仍然有效，然后从最后一个 completed step 后继续。
- `completed`：检查 final output，并执行其中最接近的后续动作；若没有明确动作，则复核
  evidence 后关闭任务。

规则只组合已有结构化信息，不推断新的事实。

## Error Handling

没有 trace evidence 时仍生成包含全部七个标题的 handoff，并对空区块写
`None recorded.`。

Writer 在 `handoff.md` 所在目录创建唯一临时文件，完整写入后再执行 `rename`。临时文件
写入失败或 rename 失败时抛出明确错误，使 CLI 以失败状态退出；rename 之前的失败必须
保留上一份完整 `handoff.md`。失败后应尽力清理本次临时文件，但清理错误不能覆盖原始
写入错误。

handoff 生成发生在 terminal trace 持久化之后。因此 handoff 基础设施失败不会伪造
Coding workflow 终态，也不会修改已经落盘的 JSONL 审计结果。

## Testing Strategy

使用 `node:test` 和 `node:assert/strict`，遵循现有 TypeScript 测试风格：

- Builder 单元测试覆盖 completed、failed、blocked 三类核心终态，并验证 cancelled 的
  next-action 映射。
- Renderer 单元测试验证七个标题总是存在，空区块有明确占位文本。
- 压缩测试验证空白折叠、去重、条目限制和带标记的文本截断。
- 安全测试使用包含长 stdout、prompt 和敏感环境变量形态的 trace，验证这些原始字段
  不进入 Markdown。
- Writer 测试在临时目录验证原子覆盖，并注入写入失败以确认旧文件仍完整保留。
- composition 测试验证 configured Coding run 结束后在 workspace 根目录生成
  `handoff.md`，且内容引用同一次运行的 request、终态和 trace evidence。

完成实现后运行：

```bash
npm test
npm run build
```

## Acceptance Criteria

- 新 Agent 或人类仅阅读 `handoff.md`，即可知道任务目标、终态、已完成工作、待确认问题、
  关键证据、失败尝试和下一步行动。
- handoff 不包含完整日志、原始 prompt、shell stdout/stderr 或其他不可行动的长文本。
- 所有 Coding mode 终态都会自动、原子地更新 workspace 根目录的 `handoff.md`。
- handoff 写入失败可见且不会损坏上一份完整 handoff。
- 离线单元测试与 TypeScript build 全部通过。
