# 可校验 Subagent Contract 设计

## 背景与目标

当前 coding workflow 已在未来架构中预留 subagent，但尚未定义可以由主 loop
稳定消费的输入与输出协议。本次只把 subagent 的边界固化为 TypeScript 类型、Zod
schema、跨对象校验函数和三个示例；不实现真实调度、并发、handoff、模型调用或
subagent 生命周期管理。

核心原则是：subagent 不是另一个自由聊天模型，而是由 contract 限定任务、权限、
上下文、交付物和执行预算的任务执行单元。任何 subagent 结果都必须先通过统一协议
校验，才能作为 evidence 进入主 loop。subagent 无权决定整体 workflow 是否完成。

## 方案选择

采用“统一结果信封 + JSON-compatible 扩展字段”。

- 不采用完全开放的 `Record<string, unknown>`，因为函数、类实例或循环引用无法安全
  写入 JSONL trace，也会破坏跨进程传递。
- 暂不要求 coordinator 使用泛型 schema 工厂解析每个角色的专有 payload，因为本次
  不实现执行层；角色示例可以额外提供自己的 Zod schema，对 `extensions` 二次收紧。
- 主 loop 只依赖统一结果信封中的状态、摘要、evidence 和错误，不依赖角色专有字段。

## Contract

领域合同放在 `src/domain/subagent-contract.ts`，保持 provider-neutral，不引用 Agents SDK。
同一文件导出 TypeScript 类型、Zod schema 和跨对象验证函数。

```ts
interface SubagentContract {
  id: string;
  role: "search-agent" | "test-agent" | "reviewer-agent";
  task: string;
  scope: {
    include: string[];
    exclude: string[];
    constraints: string[];
  };
  allowedTools: AllowedSubagentTool[];
  contextPackage: {
    items: SubagentContextItem[];
    maxChars: number;
  };
  expectedOutput: {
    format: "subagent-result";
    requirements: string[];
  };
  evidenceRequirements: {
    requiredKinds: string[];
    minimumCount: number;
  };
  limits: {
    timeoutMs: number;
    maxSteps: number;
  };
}
```

字段语义如下：

- `task`：单一、可验证的任务目标，不携带隐含 workflow 所有权。
- `scope`：允许读取或检查的路径，以及明确的排除项和行为约束。空 `include` 非法，
  防止把整个 workspace 默认为无限范围。
- `allowedTools`：使用稳定的 capability 名称，而不是 provider 或 SDK tool 实例。首批值为
  `read`、`search`、`test` 和 `diff`；schema 拒绝未知 capability。
- `contextPackage`：只携带完成任务所需的有来源上下文。`maxChars` 是静态打包上限；schema
  会校验所有 item 内容的字符数总和不超过该值。
- `expectedOutput`：固定要求统一结果信封，并用非空 requirements 描述角色交付物。
- `evidenceRequirements`：定义成功结果必须提供的 evidence 类型和最小数量。
- `limits`：`timeoutMs` 与 `maxSteps` 都必须是正整数。它们是未来执行器必须实施的预算，
  本次仅验证配置，不启动计时器或 step runner。

`SubagentContextItem` 包含稳定 `id`、`kind`、`source` 和 `content`。`kind` 使用开放的非空
字符串，以便未来接入现有 ContextManager 设计而不修改 contract 外层结构。

## 统一结果信封

```ts
interface SubagentResult {
  contractId: string;
  role: SubagentRole;
  status: "completed" | "failed" | "blocked" | "timed_out";
  summary: string;
  evidence: WorkflowEvidence[];
  errors: SubagentError[];
  extensions?: JsonObject;
}
```

- `summary` 是供主 loop、日志和人类读取的有界结论，不替代 evidence。
- `evidence` 复用现有 `WorkflowEvidence` 的 `kind`、`source`、`summary` 形状，使校验后的
  结果可以直接合并进 `CodingWorkflowState.evidence`。
- `errors` 使用结构化错误项，至少包含 `code`、`message` 和 `retryable`，避免用自由文本
  猜测失败类别。
- `extensions` 只能是递归 JSON object。它保存角色专有数据，但不是主 loop 判断状态的
  必需输入。

结果不包含 `WorkflowTransition`、stop reason 或整体 completion decision。最终 verify 和
stop 始终由主 workflow 持有。

## 跨对象校验

`validateSubagentResult(contract, result)` 先分别解析 contract 与结果 schema，再验证：

1. `result.contractId` 与 contract `id` 相同；
2. `result.role` 与 contract `role` 相同；
3. `completed` 结果的 evidence 数量不少于 `minimumCount`；
4. `completed` 结果覆盖全部 `requiredKinds`；
5. evidence `source` 必须是 scope 内路径，或者是 context item id、允许工具名、contract id
   等协议认可的逻辑来源；
6. `completed` 结果没有 errors，非 `completed` 结果至少包含一个 error；
7. `timed_out` 保持独立终态，不能携带伪装为完成的状态。

该函数返回已解析的 `SubagentResult`；校验失败抛出 ZodError，使未来 coordinator 能使用
统一的 schema 错误路径。路径归属采用纯词法、workspace-relative POSIX 路径判断，不访问
文件系统，不跟随 symlink；真实执行层仍必须复用 workspace path guard 做安全校验。

## 三个示例

示例放在 `src/subagents/examples/`，每个模块导出一个 contract 和一个能够通过校验的结果。
示例是可导入 fixture，不是自然语言文档片段。

### search-agent

- 任务：在指定 `src/` 范围查找与某个符号或行为相关的文件。
- 工具：`read`、`search`。
- 必需 evidence：搜索查询和匹配摘要；无匹配时也必须提供明确的搜索范围与空结果证据。
- `extensions`：`matches[]`、`searchedPaths[]`，并由示例专用 schema 校验路径、行号和摘要。

### test-agent

- 任务：运行 contract 明确允许的最小测试命令并归纳结果，不修改源文件。
- 工具：`read`、`search`、`test`。
- 必需 evidence：测试命令和 test result。
- `extensions`：`command`、`exitCode`、`failedTests[]`。非零 exit code 可以是有效诊断证据，
  不自动等价于 subagent runtime failure。

### reviewer-agent

- 任务：审查指定 diff 和文件范围，报告可定位、可行动的问题。
- 工具：`read`、`search`、`diff`。
- 必需 evidence：review scope；有发现时每项还包含位置、严重级别和依据。没有问题时返回
  明确的空 findings，而不是虚构问题。
- `extensions`：`findings[]`、`reviewedFiles[]`，finding 包含 severity、file、line、title
  和 rationale。

## 主 Loop 消费方式

未来 coordinator 的消费顺序固定为：

```text
SubagentResult
  -> Zod schema parse
  -> contract/result invariant validation
  -> merge validated evidence into CodingWorkflowState
  -> main workflow verify
  -> main workflow stop decision
```

本次只实现前两步和可直接合并的 evidence 形状，不修改 workflow runner 或 coding mode。
因此 contract 是后续执行机制的输入边界，而不是提前实现一个隐式 dispatcher。

## 错误与安全边界

- 空任务、空 scope、未知工具、重复工具、无效预算和超出 `maxChars` 的 context 被拒绝。
- 自由文本结果、未知 role、缺少必需 evidence、状态与 errors 矛盾、以及包含非 JSON 值的
  `extensions` 被拒绝。
- contract 中的 allowed tools 只是 capability allowlist；真实 tool 调用仍需执行层权限检查。
- contract 和示例不得包含凭据、环境变量值、真实 trace 内容或不受限命令输出。
- schema 不声称实施 timeout 或 maxSteps；只有未来 executor 才能产生可信的 `timed_out`。

## 测试策略

新增 `tests/unit/subagent-contract.test.ts`，使用 `node:test` 和 `node:assert/strict` 覆盖：

- 完整合法 contract 与统一结果信封；
- 三个示例均通过通用校验和各自的 extension schema；
- contract id 或 role 不匹配；
- completed 结果缺少 evidence、缺少 required kind 或错误地携带 errors；
- failed、blocked、timed_out 缺少结构化 error；
- scope 外路径 evidence；
- 非 JSON extension；
- 非正整数 timeout/maxSteps、未知或重复工具；
- context 字符总数超过 `maxChars`；
- 返回对象不包含 transition 或整体 stop decision。

完成前运行 `npm test`、`npm run build` 和 `git diff --check`。不运行付费 live integration。

## 非目标

- 不创建或运行真实 subagent；
- 不实现并发队列、调度、handoff、取消或重试；
- 不修改主 workflow 状态推进和 stop decision；
- 不接入 Agents SDK、模型 provider 或新工具；
- 不实现 token 估算、context compaction 或持久化；
- 不把角色专有 `extensions` 变成主 loop 的必需依赖。
