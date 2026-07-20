# Reviewer Subagent 运行与复审闭环设计

## 背景与目标

当前 Coding workflow 在 executor 返回结构化 summary 和 evidence 后直接报告成功。仓库虽然
已经定义 `SubagentContract`、`SubagentResult`、跨对象校验函数和 reviewer-agent 示例，
但还没有真实 subagent 运行层，也没有独立复核 executor 结论的机制。

本次实现一个遵循现有统一协议的真实 reviewer-agent，并把 Coding workflow 扩展为：

```text
executor → reviewer → pass / revise / ask_user
```

reviewer 必须检查：

1. summary 中的重要结论是否有 trace evidence 支持；
2. summary 是否遗漏 trace 中的失败信息；
3. executor 是否跳过完成当前任务所需的验证。

reviewer 只读取 coordinator 提供的 trace 快照和 executor summary，不拥有文件、搜索、
diff、shell 或其他工具，也不直接执行修复。它返回经过协议校验的复审建议；最终 workflow
transition 仍由主 coordinator 决定。

## 方案选择

采用“完整复用统一 Subagent Contract + 角色专属 extension + coordinator 映射”的方案。

- 不采用 Coding 专用 reviewer 接口，因为它会绕过刚建立的 subagent 身份、evidence、错误和
  limits 协议，形成第二套运行边界。
- 不采用纯规则 reviewer，因为规则可以发现显式 `tool_failed`，却不能可靠判断自然语言结论
  是否受到 evidence 支持，或某项验证对当前任务是否必要。
- 不让 reviewer 直接返回 `WorkflowTransition`。`pass`、`revise`、`ask_user` 是角色建议，
  coordinator 校验后再映射为 workflow 控制，继续遵守“subagent 不拥有整体 workflow”的边界。

search-agent 和 test-agent 本次仍只保留可导入示例。通用运行层为未来接入它们提供边界，但
本次不实现它们的真实 Agent、工具装配或 workflow 路由。

## 通用 Subagent 运行层

新增 provider-neutral 的运行函数，接收：

- 已构造的 `SubagentContract`；
- 一个注入的 `SubagentInvoker`；
- 可选的角色专属 extension schema；
- trace writer 和时间源。

运行顺序固定为：

```text
parse contract
  → write subagent_started
  → invoke with context / allowedTools / maxSteps / AbortSignal
  → parse unified result
  → validate contract/result invariants
  → validate role extension
  → write subagent_finished
  → return validated result
```

`SubagentInvoker` 是 SDK 中立接口。它接收 contract 编译出的 prompt、稳定 capability 名称、
`maxSteps` 和 `AbortSignal`，返回未知结构，由运行层负责校验。真实 reviewer adapter 使用
Agents SDK；离线单元测试注入普通异步函数。

### 预算实施

- `timeoutMs` 由运行层创建 `AbortController` 和 timer，并把 signal 传给 invoker。超时得到
  `status: "timed_out"` 和结构化 `subagent_timeout` 错误。
- `maxSteps` 必须传给 invoker。Reviewer SDK adapter 将它映射为 Runner 的 `maxTurns`；
  `MaxTurnsExceededError` 映射为结构化 `subagent_max_steps_exceeded` 错误。
- timer 在成功和所有失败路径中清理，不能让已完成运行继续持有定时任务。

### 错误归一化

模型异常、无 final output、统一 result schema 错误、contract/result 不变量错误和角色 extension
错误都不能作为成功结果进入 workflow。运行层使用已知 contract id/role 构造合法的
`status: "failed"` 结果，错误 code 区分 invocation、invalid_result 和 max steps。

失败结果仍通过现有 `validateSubagentResult()`，确保非 completed 状态携带结构化错误。运行层
不把原始堆栈、API 响应或凭据写进 result/trace。trace writer 写入失败不被归一化，而是直接
reject；审计链不完整时不能返回任何可信终态。

## Reviewer Contract 与 Agent

每个 executor attempt 都由 coordinator 构造一个 reviewer contract。contract id 包含稳定的
attempt 编号，role 固定为 `reviewer-agent`。

### 权限边界

```ts
allowedTools: []
```

Reviewer SDK Agent 的 `tools` 同样固定为空数组，并且工厂不接受外部 tools 参数。协议层和
SDK 层共同保证 reviewer 不会退化为第二个 executor。`scope.constraints` 明确禁止执行工具、
修改 workspace 或补做验证。为继续满足现有 contract 对非空 scope 的要求，reviewer 使用
`include: ["traces"]` 和空 exclude；该 scope 描述它审查的逻辑资源类型，不赋予文件读取能力，
实际可见数据仍严格限制为 context package 中的两个 item。

### Context package

Context 只包含两个有来源 item：

- `coding-trace`：本次调用前已经成功写入的 trace 快照，使用 JSON 序列化；
- `executor-summary`：当前 executor 输出的 summary。

contract 的 `maxChars` 是显式上限。超过上限时 contract 构造失败，不静默截断 failure 或
evidence；workflow 将其视为 reviewer runtime failure，而不是让 reviewer 基于不完整上下文
给出 pass。

### Evidence requirements

completed reviewer result 至少包含：

- `review_decision`：source 为 reviewer contract id；
- `trace_reference`：source 为 `coding-trace`。

这些来源都符合现有逻辑 source allowlist。Reviewer 不把任意绝对路径或宿主机数据伪装为
evidence source。

### 角色专属 extension

```ts
interface ReviewerAgentExtensions {
  decision: "pass" | "revise" | "ask_user";
  checks: Array<{
    criterion:
      | "conclusion_evidence"
      | "failure_disclosure"
      | "required_validation";
    status: "passed" | "failed" | "needs_user";
    summary: string;
    traceReferences: number[];
  }>;
  revisionInstructions: string[];
  userQuestion?: string;
}
```

静态 `reviewerAgentExtensionsSchema` 校验 extension 结构和字段组合；另一个接收冻结 trace
快照的 `validateReviewerAgentResult()` 先调用现有 `validateSubagentResult()`，再执行以下
跨字段不变量：

1. 三种 criterion 必须各出现一次，不能缺失或重复；
2. 每个 check 至少引用一个非负 trace 下标；
3. 每个下标都必须存在于 reviewer 调用前的冻结快照中；
4. `pass` 要求三项全部为 `passed`，revision instructions 为空且没有 user question；
5. `revise` 至少有一项 `failed`，必须提供非空修改指令且没有 user question；
6. `ask_user` 至少有一项 `needs_user`，必须提供具体 user question；
7. `failed` 或 `timed_out` 的统一结果不要求成功 extension，且不能被映射为语义 decision。

`ask_user` 只用于缺少必须由用户提供的输入、授权或选择。executor 能通过现有 trace/evidence
修正的问题必须返回 `revise`，不能借 `ask_user` 提前终止。

## Trace 快照与可追溯性

新增一个只用于 Coding composition 的 recording trace writer decorator。它先委托底层 writer
持久化事件，只有写入成功后才把同一个事件加入内存快照，因此 reviewer 永远不会引用一个
实际没有进入 JSONL 的事件。

现有 Coding tools、executor、workflow 和 reviewer 都接收同一个 recording writer。这样快照
同时包含工具成功、工具失败、审批、workflow 和 coding 级事件，而不是只有 coordinator 自己
写出的局部 trace。

新增事件：

- `coding_execution_completed`：记录 attempt、executor summary 和 evidence；
- `subagent_started`：记录 contract id、role、context item ids、allowed tools 和 limits，不复制
  context 正文；
- `subagent_finished`：记录经过统一协议及角色 schema 校验的 `SubagentResult`。

Reviewer 的 `traceReferences` 使用冻结快照中的零基下标。`subagent_finished` 保存 checks 和引用，
因此事后读取 JSONL 可以从 decision 反查 executor summary、evidence、tool failure 和 validation
记录。调用中的 `subagent_started` 不属于冻结输入，不能被 reviewer 引用作为判断依据。

## Coding Workflow 集成

保留分类器、四种任务类型、`understand_request` 和已有成功 stop reason。原执行步骤内部扩展为
一次完整 attempt：

```text
executor
  → coding_execution_completed
  → freeze trace snapshot
  → build reviewer contract
  → run reviewer subagent
  → coordinator maps recommendation
```

映射规则：

- `pass`：保存当前 summary/evidence，并使用任务原有成功 stop reason；
- `revise`：把 reviewer 的 revision instructions 写入 workflow state，再次进入同一个执行步骤；
- `ask_user`：保存 user question，停止为 `blocked + user_action_required`；
- reviewer `failed` 或 `timed_out`：停止为 `failed + reviewer_failed` 或
  `failed + reviewer_timed_out`；
- executor 自身 stopped：保持现有映射，不调用 reviewer，因为没有可复审的成功 summary。

`CodingExecutor` 输入增加可选的 revision instructions。首次调用为空；后续 prompt 明确分隔原始
任务、workflow instructions 和 reviewer feedback，防止 feedback 被误当成用户原始要求。

每次完整 executor/reviewer attempt 仍占一个 workflow step。`understand_request` 占第一步，
当前 `maxSteps: 3` 因而允许首次执行以及一次 revision；不修改共享配置，也不改变普通七阶段
Loop 的步数语义。若最后一次 attempt 返回 `revise`，下一次路由会由现有 workflow runner 的
上限稳定终止为 `max_workflow_steps_exceeded`。

## 状态与终态

`CodingWorkflowState` 新增 attempt、revision instructions 和已接受 output/evidence。未通过
reviewer 的 summary 不成为最终成功 output；它只存在于 `coding_execution_completed` trace，
供复审和审计使用。

新增 Coding stop reason：

- `reviewer_failed`；
- `reviewer_timed_out`。

`ask_user` 复用现有 `user_action_required`，无需新增 WorkflowStatus。终端 trace 和
`CodingRunResult` 继续由同一 helper 构造，避免返回值与审计终态不一致。

## 文件组织

预计文件边界如下：

- `src/subagents/subagent-invoker.ts`：provider-neutral invoker 输入和错误类型；
- `src/subagents/run-subagent.ts`：预算、统一校验、错误归一化和 subagent trace；
- `src/subagents/reviewer/reviewer-contract.ts`：动态 contract 与专属 extension schema；
- `src/subagents/reviewer/create-reviewer-agent.ts`：无工具 SDK Agent；
- `src/subagents/reviewer/run-reviewer-agent.ts`：Runner adapter 和 max-turn 映射；
- `src/trace/recording-trace-writer.ts`：持久化成功后记录的快照 decorator；
- `src/trace/trace-event.ts`：新增 coding execution 和 subagent events；
- `src/modes/coding/*`：workflow state、复审闭环和 composition 装配；
- `tests/unit/*`：通用运行层、reviewer contract/Agent、trace recorder 和 Coding 集成测试；
- `README.md`：记录 reviewer 语义、无工具边界和新增终态。

现有 `src/subagents/examples/reviewer-agent-example.ts` 会更新为新 extension 的静态合法示例，
继续与 search/test 示例一起验证统一合同。

## 测试策略

所有单元测试离线运行，使用 `node:test`、`node:assert/strict`、假 invoker、内存 trace writer 和
确定性 clock。至少覆盖：

1. 通用运行层成功执行并传递 allowed tools、max steps 和 signal；
2. timeout 会 abort invoker、清理 timer 并返回合法 timed_out result；
3. max-turn、模型异常、无输出和非法 result 被归一化，trace 失败仍 reject；
4. reviewer Agent 的 SDK tools 精确为空；
5. reviewer 三项 criterion 的缺失、重复、非法组合和越界 trace 引用被拒绝；
6. 有 evidence、未遗漏失败且完成必要验证时 `pass`；
7. 缺少 evidence、遗漏失败或跳过验证时 `revise`，feedback 进入下一次 executor；
8. 只有用户可补充的缺口产生 `ask_user`；
9. executor stopped 时 reviewer 不运行；
10. reviewer failed/timed_out 不会产生 completed 终态；
11. `maxSteps` 限制 revision loop；
12. recording writer 不记录底层写入失败的事件，trace reference 可反查持久事件；
13. 原有四种 Coding task 类型、普通 Loop、search/test contract 示例保持回归通过。

完成前运行：

```bash
npm test
npm run build
git diff --check
```

不运行付费 live integration。

## 安全与非目标

- reviewer 不访问 workspace，不执行工具，不修改文件，不运行测试，不生成 diff；
- reviewer 不拥有 workflow transition、最终状态或 stop reason；
- 不实现 search-agent/test-agent 的真实运行；
- 不实现并发 subagent、handoff、重试队列、持久 RunState 或跨进程调度；
- 不静默裁剪 trace、失败信息或 reviewer context；
- 不把 API key、环境变量值、原始异常堆栈或未清洗工具输出写入 trace；
- 不修改普通七阶段 Loop 的执行流程和业务停止规则。
