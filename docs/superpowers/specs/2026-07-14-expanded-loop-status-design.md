# Expanded Loop Status Design

## 背景

当前 loop 只支持 `running | completed | failed`。工具授权被拒绝或工具调用失败后，
Agents SDK 会把结构化 `ToolError` 返回模型，但 `runAct()` 仍把任意非空最终文本视为
成功的 action。骨架 verifier 又仅以 `stepIndex >= 3` 判断通过，因此即使最终输出明确
表示任务无法完成，第三轮仍会得到 `completed / plan_condition_met`。

本设计扩展 loop 和 act 状态，使用户拒绝、需要用户操作、不可恢复错误、可继续迭代和
真实成功拥有不同的终态语义。它不引入 Reviewer Agent，也不增加模型调用。

## 目标

- 只有 Actor 明确报告 `succeeded`，并通过确定性 verifier，loop 才能 completed。
- 用户拒绝授权后，Actor 可以在同一 act 中尝试 allowed 工具或其他安全替代方案。
- 没有替代方案时，拒绝、阻塞和技术失败分别得到 cancelled、blocked 和 failed。
- 所有真实 ToolError 由 runtime 收集并附加到 ActData，不能由模型删除或伪造。
- 第三次迭代不再自动表示业务成功。
- CLI 和 trace 使用 `executedSteps` 表示实际记录的迭代数量。

## 非目标

- 不实现独立 Reviewer Agent 或语义评审模型。
- 不改变 workspace、shell allowlist 或 approval-required 权限规则。
- 不根据“曾经发生过工具错误”自动否定后续成功的替代方案。
- 不加入自动重试次数、退避算法或持久化恢复机制。

## 状态模型

### Loop 状态

```ts
export type LoopStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
```

- `running`：仍可执行后续 LoopStep。
- `completed`：Actor 报告 succeeded，且 verifier 通过。
- `failed`：stage exception、maxTurns、maxSteps 或不可恢复 action/tool failure。
- `blocked`：继续任务需要当前运行无法获得的用户操作或授权。
- `cancelled`：用户拒绝关键授权，Actor 确认没有安全替代方案。

`LoopStep.status` 同步扩展为 `running | completed | failed | blocked | cancelled`。
terminal action 产生的当前 step 与顶层 LoopState 使用同一个终态，避免出现 loop blocked
但最后一个 step 却显示 completed 的矛盾。

### Act 状态

Actor 使用 Agents SDK 的 Zod `outputType` 返回：

```ts
export const actorOutputSchema = z.object({
  output: z.string().min(1),
  outcome: z.enum([
    "succeeded",
    "continue",
    "failed",
    "blocked",
    "cancelled",
  ]),
});
```

runtime 将真实工具错误合并为持久化的 ActData：

```ts
export interface ActData {
  output: string;
  outcome:
    | "succeeded"
    | "continue"
    | "failed"
    | "blocked"
    | "cancelled";
  toolErrors: ToolError[];
}
```

- `succeeded`：目标已通过当前 action 或安全替代方案完成。
- `continue`：已有可用进展，但仍需新的 LoopStep。
- `failed`：技术或业务 action 无法恢复。
- `blocked`：需要用户操作、交互终端或缺失上下文。
- `cancelled`：用户拒绝关键操作且没有安全替代方案。

## ToolOutcomeRecorder

新增 run-scoped recorder，由三个工具、审批协调层和 `runAct()` 共享：

```ts
export interface ToolOutcomeRecorder {
  checkpoint(): number;
  recordFailure(error: ToolError): void;
  failuresSince(checkpoint: number): ToolError[];
}
```

`runAct()` 在首次调用 Runner 前取得 checkpoint。file/search/shell 的
`traceToolExecution()` 在得到失败 ToolResult 时记录同一个 ToolError；授权拒绝和授权
不可用不会进入工具 execute wrapper，因此由 `runAct()` 在构造 approval ToolError 后
显式记录。最终 `failuresSince(checkpoint)` 附加到 ActData。

recorder 只记录真实 runtime failure。Actor 的结构化输出不包含 `toolErrors` 字段，因此
模型不能遗漏、修改或伪造审计证据。

历史工具错误不自动导致失败。如果 Actor 在错误后找到替代方案，它可以返回
`succeeded` 或 `continue`；原 ToolError 仍保留在 ActData 和 trace 中。

## 阶段流转

```text
act.outcome === succeeded
  → verify → reflect → stop(completed)

act.outcome === continue
  → verify(not passed) → reflect → stop(running 或 max_steps_exceeded)

act.outcome === failed | blocked | cancelled
  → stop
  → verify、reflect 标记 skipped
```

`runAct()` 根据 outcome 返回对应 StepDecision：terminal outcome 直接进入 stop；
`succeeded` 和 `continue` 进入 verify。

`runVerify()` 不再读取 `stepIndex` 作为业务成功条件。当前无 Reviewer Agent，因此采用
确定性骨架检查：

```ts
const passed = input.action.outcome === "succeeded";
```

这不声称提供独立语义验证；它只保证 `continue/failed/blocked/cancelled` 不能因迭代次数
被升级为成功。

## StopDecision

StopReason 扩展为：

```ts
export type StopReason =
  | "plan_condition_met"
  | "max_steps_exceeded"
  | "max_turns_exceeded"
  | "step_error"
  | "tool_error"
  | "action_failed"
  | "user_action_required"
  | "action_cancelled"
  | "approval_required"
  | "approval_rejected";
```

决策优先级：

1. stage exception 或 MaxTurnsExceededError：failed。
2. action blocked：blocked；存在 approval_required 时使用该 reason，否则使用
   user_action_required。
3. action cancelled：cancelled；存在 approval_rejected 时使用该 reason，否则使用
   action_cancelled。
4. action failed：有 ToolError 时为 tool_error，否则为 action_failed。
5. verification passed：completed / plan_condition_met。
6. 达到 maxSteps：failed / max_steps_exceeded。
7. 其余情况：running。

blocked/cancelled 的 Agent 输出应与对应 runtime evidence 一致。若没有匹配的审批错误，
仍保留 Actor 的 terminal outcome，并使用 user_action_required/action_cancelled，避免制造
不存在的审批事实。

## CLI 与 trace

LoopStoppedEvent 和 CLI 摘要将：

```ts
completedSteps: state.steps.length
```

改为：

```ts
executedSteps: state.steps.length
```

这个值统计已经记录的 LoopStep 数量，不声称每个 step 都成功。CLI 在 failed、blocked、
cancelled 时设置非零 exit code；completed 保持零。

## 错误处理边界

- Zod 结构化输出解析失败属于 act stage error，最终 failed / step_error。
- approval rejected 后仍恢复同一个 SDK RunState，让 Actor 有机会选择替代方案。
- approval unavailable 同样作为 ToolError 返回 Actor；若替代方案成功可以 succeeded，
  否则 Actor 返回 blocked。
- recorder 不替代 trace。trace 是持久审计，recorder 是当前 run 的类型化内存视图。
- trace 写入失败仍向上抛出，不允许在缺失审计证据时报告成功。

## 测试策略

按 TDD 增加以下行为测试：

1. recorder checkpoint 只返回当前 act 之后的错误，并保持对象内容不变。
2. 工具失败同时进入 trace 和 recorder；工具成功不记录 failure。
3. 用户拒绝后 Actor 返回 succeeded，表示替代方案成功，允许 completed。
4. 用户拒绝后 Actor 返回 cancelled，得到 cancelled / approval_rejected。
5. 非交互批准不可用且 Actor 返回 blocked，得到 blocked / approval_required。
6. 普通 ToolError 无法恢复时得到 failed / tool_error。
7. 没有 ToolError 的 failed action 得到 failed / action_failed。
8. 没有匹配审批错误的 blocked/cancelled 使用通用 stop reason。
9. continue 会进入下一 step；到达 maxSteps 后得到 max_steps_exceeded。
10. stepIndex 为 3 不再自动让 verifier 通过。
11. terminal action outcome 会跳过 verify 和 reflect，并同步最后一个 LoopStep 状态。
12. CLI 和 loop_stopped trace 输出 executedSteps。
13. 现有 workspace、工具 contract、审批恢复、单元测试和 TypeScript build 保持通过。

## 验收标准

- 用户拒绝关键操作且没有替代方案时，不再返回 completed。
- 用户拒绝后成功执行替代方案时，可以正常 completed。
- `blocked`、`cancelled` 能贯穿 domain state、stop decision、trace 和 CLI。
- `completed` 只能由 succeeded action 和 passed verification 产生。
- 输出中不再把 `state.steps.length` 命名为 completedSteps。
