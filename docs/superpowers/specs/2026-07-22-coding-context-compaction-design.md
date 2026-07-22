# Coding Context Compaction Design

## 1. 目标与范围

本次只为 Coding workflow 实现 context compaction，不改变普通 `npm run loop`
的执行链。目标是在 Coding Agent 的单次 `runner.run` 内部，即使 model、tool
持续往返，也能把每次模型调用的输入限制在确定的字符预算内，同时满足：

- 最近步骤保留原文；
- 旧的成功工具结果转为确定性摘要；
- 关键 evidence 固定保留；
- 失败尝试保留原因、处理建议和失败结论；
- 每次实际 compaction 的前后状态都写入本地 JSONL trace。

首版不调用额外模型生成摘要，不实现跨任务 memory，也不把 compaction 接入普通
loop、classifier 或 reviewer。现有 `docs/context-packing-policy.md` 继续作为长期的
provider-neutral 策略；本设计是 Coding workflow 的首个可执行切片。

## 2. 方案选择

### 2.1 采用 SDK 每轮输入过滤钩子

使用当前 `@openai/agents` 提供的 `callModelInputFilter`。该钩子在每次调用模型前
接收完整 `AgentInputItem[]`，因此能处理同一次 `runner.run` 内不断累积的工具历史，
而不仅是 workflow 两次 executor 尝试之间的外层 prompt。

优点是保留现有 Agent、tool 和 approval 生命周期，且真正约束 `maxTurns` 内的输入。
主要风险是工具调用和工具结果存在关联约束，因此 compactor 必须把二者作为原子组，
不能留下 orphan call 或 orphan result。

### 2.2 未采用的方案

- 将一个 Agent run 手动拆成多个短 run：会丢失 pending tool/approval 状态，并增加
  副作用重放风险。
- 建立外置持久 session/context ledger：未来扩展性更强，但首版会与 JSONL trace 和
  SDK RunState 形成多份事实来源，超出当前需求。

## 3. 配置

在 loop 配置中新增带默认值的 `contextCompaction`：

```ts
interface ContextCompactionConfig {
  maxInputChars: number;
  keepRecentItems: number;
  maxToolSummaryChars: number;
}
```

默认值为：

```json
{
  "maxInputChars": 60000,
  "keepRecentItems": 8,
  "maxToolSummaryChars": 1200
}
```

三个值都必须是正整数。字符预算包括 system instructions 和全部 input items 的确定性
序列化长度。字符计量不是 token 精确值，但它与 provider 无关、无需联网，并能提供稳定、
可重复测试的硬上界。

## 4. 模块边界

新增 `src/context/`，内部职责拆分如下：

- context 配置与结果类型：定义预算、固定 evidence 和压缩统计；
- item 计量与分组：确定性计算字符数，并按 call ID 关联 tool call/result；
- 工具结果摘要器：只处理旧的成功工具结果和旧失败结果，不调用模型；
- Coding input compactor：执行分类、选择、摘要、预算复核和 trace 生命周期。

`runCodingAgent` 只负责把 compactor 作为 `callModelInputFilter` 注入 SDK，并把
`pinnedEvidence`、配置、trace writer 和时钟传给它。它不自行实现裁剪规则。

`CodingWorkflowState.evidence` 会作为 `pinnedEvidence` 传给下一次 executor 尝试。
`createCodingExecutorPrompt` 将其放在可信的 `coordinatorData.contextPackage` 中；原始
用户请求仍留在 `untrustedRequestData`，不能借 evidence 字符串提升指令权限。

## 5. 数据模型

compactor 的输入和结果保持 provider-neutral：

```ts
interface CompactionContext {
  pinnedEvidence: WorkflowEvidence[];
}

interface CompactionResult {
  input: AgentInputItem[];
  beforeChars: number;
  afterChars: number;
  retainedGroups: number;
  summarizedToolResults: number;
  pinnedEvidenceIds: string[];
}
```

Evidence ID 由 `kind`、`source` 和 `summary` 的确定性序列化生成稳定摘要标识；trace
用该标识证明某条 evidence 在压缩前后仍存在，而不重复写入大段正文。

逻辑组分为：

- 初始任务组：原始请求、归一化目标、workflow instructions 和 reviewer revision；
- tool 组：一个 tool call 与使用同一 call ID 的 result；
- 普通消息组：单个 user 或 assistant item；
- opaque 组：reasoning 或当前实现不认识的 SDK item。

初始任务组、显式 `pinnedEvidence` 和失败结论属于固定内容。opaque 组不做结构改写；
若它位于最近窗口内则保留原文，否则仅能作为完整组保留或删除，不能猜测其内部语义。

## 6. Compaction 算法

每次模型调用前执行以下步骤：

1. 对 instructions 与 input items 做确定性计量。未超过 `maxInputChars` 时逐项原样返回，
   不写 compaction trace，避免无意义的日志噪声。
2. 将输入转换为逻辑组，并验证 tool call/result 的关联关系。输入顺序保持不变。
3. 写入 `context_compaction_started`，记录预算、压缩前字符数、item 数和逻辑组数。
4. 固定保留初始任务、显式 evidence 以及失败原因/结论。
5. 固定保留末尾 `keepRecentItems` 个逻辑组的完整原文。这里的 “items” 按逻辑组计数，
   所以一对 tool call/result 只占一个最近名额。
6. 对不在最近窗口内的成功工具结果做确定性摘要。tool call 保持原结构；result 的 output
   被替换为合法、短小的 JSON 文本，包含 tool、operation、call ID、成功状态、来源、
   原始字符数和内容头尾片段。
7. 对旧失败工具结果生成结构化失败摘要，必须保留 `type`、`message`、`retryable`、
   `userActionRequired`、`suggestedNextStep`、`evidence`，以及 “该尝试未成功” 的明确结论。
8. 重新计量。若仍超限，继续删除最旧、未固定且不属于最近窗口的普通/opaque 组；不得
   删除固定内容、最近窗口或 tool pair 的一半。
9. 再次验证 tool 关联与预算，写入 `context_compaction_completed`，然后才允许调用模型。

摘要字符串最多 `maxToolSummaryChars` 个字符。摘要器优先保留可解析 JSON 的稳定关键字段；
普通文本采用头尾片段，并显式记录省略字符数，不能把不确定信息改写成已确认事实。

## 7. Trace 合同

新增事件：

```ts
interface ContextCompactionStartedEvent {
  event: "context_compaction_started";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  inputItems: number;
  logicalGroups: number;
}

interface ContextCompactionCompletedEvent {
  event: "context_compaction_completed";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  afterChars: number;
  retainedGroups: number;
  summarizedToolResults: number;
  pinnedEvidenceIds: string[];
  summaries: Array<{
    callId: string;
    status: "succeeded" | "failed";
    summaryChars: number;
  }>;
}

interface ContextCompactionFailedEvent {
  event: "context_compaction_failed";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  reason: "invalid_tool_history" | "pinned_content_exceeds_budget";
}
```

Trace 保存结构化统计、evidence ID 和已经清洗的摘要清单，不复制完整巨大输入。完整工具
执行事实仍由既有 `tool_started`、`tool_completed` 和 `tool_failed` 事件负责。

如果 started 或 completed 的 trace 写入失败，filter 必须 reject，模型不会收到未审计的
压缩输入。若算法发现无法安全压缩，则在 started 之后写 failed，不写 completed。

## 8. 失败处理

新增 `ContextBudgetExceededError` 和 Coding stop reason
`context_budget_exceeded`。以下情况 fail closed：

- 固定内容加最近窗口本身已经超过预算；
- 输入存在无法安全配对的 tool call/result；
- 摘要后仍无法满足预算；
- compaction trace 无法持久化。

前三类由 `runCodingAgent` 映射为 `{ type: "stopped", status: "failed",
reason: "context_budget_exceeded" }`。trace 基础设施错误继续沿用现有
`TraceInfrastructureError` 边界向上抛出，不能伪装成普通业务失败。

## 9. 测试与验收

全部测试使用 `node:test` 和 `node:assert/strict`，先写失败测试再实现。

单元测试覆盖：

- 未超预算时 input 和 instructions 逐项不变；
- 超预算后 `afterChars <= maxInputChars`；
- 最近八个逻辑组保持字节级原文；
- 旧成功工具结果转换为相同输入必得相同输出的摘要；
- tool call/result 在所有输出中保持配对；
- pinned evidence 的 ID 和内容在压缩前后保持一致；
- 旧失败尝试保留原因、重试属性、用户动作、建议下一步和失败结论；
- 固定内容超过预算时产生 `context_budget_exceeded`；
- 实际压缩严格按 started、completed 顺序写 trace；
- 失败压缩写 started、failed，不调用模型；
- trace 写入失败时不调用模型并透传基础设施错误。

Coding Agent 集成测试构造超过预算的多轮工具历史，通过真实
`callModelInputFilter` 调用边界验证：每次送给模型的字符数有硬上界，最近结果仍是原文，
关键 evidence 可见，旧失败原因与结论可见。

最终验证命令：

```bash
npm test
npm run build
```

验收成立的证据是：所有离线测试通过、TypeScript build 通过，并且 compaction trace
能同时证明压缩前超限、压缩后不超限以及固定 evidence 未丢失。
