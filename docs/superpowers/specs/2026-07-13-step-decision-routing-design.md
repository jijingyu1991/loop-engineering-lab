# StepDecision 阶段路由设计

## 背景与目标

当前 `runLoopStep` 通过连续的局部变量和条件分支固定执行
`observe -> orient -> plan -> act -> verify -> reflect -> stop`。这种写法把阶段业务、
执行生命周期和流转顺序集中在同一个协调器中；未来若需要跳过阶段、条件分支或重试，
必须继续修改协调器。

本次改动让每个非终态阶段直接返回下一阶段决策，`runLoopStep` 只消费决策并调度。
当前仍由各阶段返回原有默认顺序，因此外部行为、trace 顺序和停止规则保持不变。

## 类型设计

新增阶段决策和阶段业务输出类型：

```ts
export type StepType = LoopStage;

export interface StepDecision {
  nextStep: StepType;
  reason: string;
}

export interface StepOutcome<T> {
  data: T;
  decision: StepDecision;
}
```

`reason` 当前保留为 `string`，便于各阶段使用清晰、稳定的机器可读原因，例如
`plan_completed`。等原因集合形成稳定协议后，再收窄为字符串字面量联合类型，避免现在
过早建立不完整枚举。

`stop` 是终态阶段，不需要 `nextStep`，继续返回现有 `StopDecision`。

## 阶段职责与默认决策

每个阶段业务函数直接返回 `StepOutcome<T>`：

| 阶段 | 默认 `nextStep` | `reason` |
| --- | --- | --- |
| `observe` | `orient` | `observation_completed` |
| `orient` | `plan` | `orientation_completed` |
| `plan` | `act` | `plan_completed` |
| `act` | `verify` | `action_completed` |
| `verify` | `reflect` | `verification_completed` |
| `reflect` | `stop` | `reflection_completed` |

`act` 当前由外部 `ActExecutor` 注入，因此其返回类型也从 `ActData` 调整为
`StepOutcome<ActData>`。CLI 和测试中的执行器按同一契约返回默认决策。

## 协调流程

`runLoopStep` 从 `observe` 开始保存一个 `currentStep`。每次执行当前阶段后：

1. `executeStage` 继续负责状态、时间戳、错误清理和 trace。
2. 阶段的 `outcome.data` 写入对应 `StageResult.data`，避免改变持久化结构。
3. 协调器读取 `outcome.decision.nextStep`，更新 `currentStep`。
4. 到达 `stop` 后执行现有停止判断并结束本轮。

协调器仍通过穷尽的 `switch` 将 `StepType` 映射到具体阶段实现，但 switch 不再表达阶段
顺序。未来修改某个阶段返回的决策即可改变路径，而无需改动调度循环。

## 失败与安全边界

阶段抛错时无法产生 `StepDecision`。运行时沿用现有容错语义：记录失败，直接转入
`stop`，并把其他仍为 `pending` 的阶段标记为 `skipped`。`MaxTurnsExceededError` 仍映射
到 `max_turns_exceeded`，其他错误映射到 `step_error`。

每个非终态阶段在一轮中最多执行一次。如果决策指向已执行阶段，协调器抛出带阶段名的
错误，防止配置错误形成无限循环。重试语义不在本次范围内；未来若需要重试，应单独设计
次数限制和 trace 表达。

## 兼容性

- `LoopStep`、`LoopState`、trace event 和 `runLoop` 返回值保持不变。
- 默认执行顺序及成功、失败停止行为保持不变。
- 直接调用阶段业务函数的代码需要从返回值的 `data` 读取原业务结果。
- README 更新为说明顺序由阶段决策产生，而不是由协调器固定编排。

## 测试策略

按 TDD 增加以下覆盖：

1. 各阶段返回预期的默认 `StepDecision`，重点验证示例
   `{ nextStep: "act", reason: "plan_completed" }`。
2. 完整 Loop 仍按默认七阶段顺序执行三轮。
3. 阶段失败时直接进入 `stop`，其余阶段记录为 `skipped`。
4. 重复阶段决策触发安全错误，不会无限执行。
5. 运行全部离线单测和 TypeScript 构建。

## 非目标

- 本次不实现由 Agent 动态选择下一阶段。
- 本次不支持阶段重试、回退或跨 `LoopStep` 跳转。
- 本次不改变 stop 条件、模型调用次数或配置格式。
