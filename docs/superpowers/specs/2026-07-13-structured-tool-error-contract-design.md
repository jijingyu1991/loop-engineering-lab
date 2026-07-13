# Structured Tool Error Contract Design

## 背景与目标

当前 Agent 尚未注册本地工具，阶段失败也只保留 `name` 与 `message`。新增文件、
搜索和 shell 工具时，需要先建立统一结果协议，使 Agent 在失败后能看到错误类型、
是否值得重试、是否需要用户介入、建议下一步和可审计证据，而不是只看到一段
`stderr`。同一份 retry 判断依据必须写入本地 JSONL trace。

本次范围包括：

- 定义 provider-neutral 的 `ToolResult<T>` 判别联合与结构化 `ToolError`；
- 实现受统一 workspace 权限根约束的文件读写、搜索和 shell 工具；
- 将三个工具注册到 Actor Agent；
- 为工具调用增加本地 trace 事件；
- 用离线单元测试覆盖成功、错误分类、安全边界和 trace。

本次不实现自动重试、交互式审批、网络工具、流式工具输出，也不运行付费 live API
测试。

## 统一结果协议

所有工具执行器都返回同一个判别联合：

```ts
export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      evidence: ToolEvidence;
    }
  | {
      ok: false;
      error: ToolError;
    };

export interface ToolError {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  userActionRequired: boolean;
  suggestedNextStep: string;
  evidence: ToolEvidence;
}
```

`ToolErrorType` 是闭合枚举，首版包含：

- `invalid_input`
- `path_outside_workspace`
- `not_found`
- `permission_denied`
- `conflict`
- `command_not_allowed`
- `approval_rejected`
- `dependency_missing`
- `timeout`
- `process_failed`
- `output_limit_exceeded`
- `internal_error`

`ToolEvidence` 是只包含 JSON-safe、已清理字段的记录。它可以包含工具名、操作名、
workspace 相对目标、稳定系统错误码、退出码、signal、耗时、匹配数，以及按配置上限
截断的 stdout/stderr 摘要。它不得包含文件写入正文、凭据、环境变量集合或未经限制的
完整命令输出。

`retryable` 的精确定义是：不改变调用输入且无需用户介入，再执行一次有合理机会成功。
timeout 可以标记为可重试；路径越界、命令未授权、输入错误和确定性的非零退出默认不可
重试。`userActionRequired` 与 `retryable` 独立，例如权限不足通常是
`retryable: false`、`userActionRequired: true`。

工具内部不自动重试。文件写入和 shell 可能产生副作用，隐藏重试会让执行次数与状态
不可审计。Agent 消费结构化结果后决定是否重试；trace 保存它作出判断所依据的字段。

## 全局工具权限配置

配置新增可选的 `tools` 节点。`tools.workspaceRoot` 是文件、搜索和 shell 共同使用的
全局权限根，可配置，缺省为 `process.cwd()`。相对值也基于 `process.cwd()` 解析。
shell 权限规则、超时和输出上限同样集中在该节点，避免各工具拥有不一致的安全配置。

建议的首版配置为：

```json
{
  "tools": {
    "workspaceRoot": ".",
    "shell": {
      "allowedExecutables": [
        { "executable": "node", "argsPrefix": [] },
        { "executable": "npm", "argsPrefix": ["test"] },
        { "executable": "npm", "argsPrefix": ["run", "build"] },
        { "executable": "git", "argsPrefix": ["status"] },
        { "executable": "rg", "argsPrefix": [] }
      ],
      "approvalRequiredExecutables": [
        { "executable": "npm", "argsPrefix": ["install"] },
        { "executable": "git", "argsPrefix": ["push"] }
      ],
      "timeoutMs": 10000,
      "maxOutputChars": 20000
    },
    "search": {
      "maxMatches": 200,
      "maxOutputChars": 20000
    },
    "file": {
      "maxReadChars": 100000
    }
  }
}
```

Schema 为缺失的 `tools` 节点和子字段提供上述默认值。CLI 只解析一次绝对
`workspaceRoot`，再把同一份 `ToolRuntimeConfig` 注入全部工具。缺省规则保持学习项目的
离线开发路径可用：文件读写与搜索自动允许；安全的只读或验证命令自动允许；安装依赖、
推送等会改变外部或依赖状态的命令需要用户确认。未匹配任一 shell 规则的调用拒绝。

权限判断在概念上统一返回 `allowed`、`approval_required` 或 `denied`。文件和搜索首版
在通过 workspace 路径校验后返回 `allowed`；只有部分 shell 规则返回
`approval_required`。`workspaceRoot` 是不可提升的硬边界：workspace 外调用始终是
`denied`，用户批准也不能绕过。

路径防护不能只做字符串前缀判断。已有目标通过 `realpath` 检查符号链接解析后的真实
路径仍位于 workspace；写入新文件时检查最近的已存在父目录的真实路径。输入中的绝对
路径、`..` 越界以及符号链接逃逸都返回 `path_outside_workspace`。trace 和模型可见
evidence 只使用 workspace 相对路径，不暴露宿主机绝对路径。

## 组件边界

领域协议与 Agents SDK adapter 分离：

- `src/agents/tools/tool-result.ts` 定义结果、错误和 evidence 类型，并提供小型错误工厂；
- `src/agents/tools/tool-runtime-config.ts` 表示 CLI 已解析的全局工具运行配置；
- `src/agents/tools/tool-permission.ts` 定义三态权限结果并匹配 executable/参数前缀规则；
- `src/agents/tools/resolve-workspace-path.ts` 独占路径解析与真实路径边界检查；
- `src/agents/tools/file-tool.ts` 实现文件执行器及 SDK adapter；
- `src/agents/tools/search-tool.ts` 实现基于 `rg` 的搜索执行器及 SDK adapter；
- `src/agents/tools/shell-tool.ts` 实现 allowlist 进程执行器及 SDK adapter；
- `src/agents/tools/create-agent-tools.ts` 用共享配置和 trace writer 组装三个工具；
- `src/agents/tools/trace-tool-execution.ts` 包装执行器并写入统一工具 trace 事件。

执行器接收普通 TypeScript 输入并返回 `ToolResult<T>`，因此无需模型或网络即可测试。
SDK adapter 只负责 Zod 参数校验、调用执行器，以及把结果作为结构化 JSON 值交给 Agent。
预期的运行链路是：

```text
model tool call
  -> SDK adapter validates input
  -> traced wrapper writes tool_started
  -> executor applies workspace/runtime policy
  -> executor returns ToolResult<T>
  -> wrapper writes tool_completed or tool_failed
  -> same ToolResult<T> becomes model-visible output
```

CLI 必须先创建 trace writer，再创建 tools 和 Agent。`createActorAgent` 接收已经组装好的
tools，不直接读取配置或构造文件系统依赖，保持 composition root 清晰。`runAct` 接收
一个可注入的 approval handler：CLI 版本通过 `node:readline/promises` 展示相对 cwd、
executable 和参数，并读取一次批准或拒绝；测试版本使用确定性 handler，不读取 stdin。

## 文件工具

文件工具提供 `read` 与 `write` 两个 action：

- `read(path)` 读取 UTF-8 文本，返回内容、字符数和字节数；超过 `maxReadChars` 返回
  `output_limit_exceeded`，建议缩小目标或改用搜索；
- `write(path, content, overwrite = false)` 默认拒绝覆盖已有文件并返回 `conflict`；
  调用方明确设置 `overwrite: true` 后才允许覆盖；
- 写入使用同目录临时文件加 rename，避免失败时留下部分内容；
- 目标为目录、父目录不存在、权限不足或 workspace 越界均转换为统一 contract。

成功 evidence 只记录 action、相对路径和字节数，不复制文件正文。

## 搜索工具

搜索工具输入包括 `pattern`、可选的 workspace 相对目录、可选 glob，以及 `regex` 开关。
它通过 `spawn("rg", args, { shell: false })` 执行，避免拼接 shell 字符串。

- `regex: false` 使用 literal 搜索，`regex: true` 才解释正则表达式；
- 没有匹配是正常成功结果，返回 `matches: []`；
- `rg` 不存在时返回 `dependency_missing`；
- 无效正则返回 `invalid_input`；
- 超过 `maxMatches` 或 `maxOutputChars` 时停止收集并返回 `output_limit_exceeded`，evidence
  记录已观察数量，建议缩小目录、pattern 或 glob。

每条匹配包含 workspace 相对文件、行号与受限文本，不返回绝对路径。

## Shell 工具

shell 工具输入为 `executable`、`args: string[]` 和可选 workspace 相对 `cwd`。实现使用
`spawn(executable, args, { shell: false })`，不支持管道、重定向、命令替换或任意 shell
字符串。每条权限规则由 `{ executable, argsPrefix }` 构成；空 `argsPrefix` 匹配该
executable 的全部参数，非空前缀只匹配对应子命令。配置解析拒绝 allowed 与
approval-required 中相同或有歧义的规则，避免审批被宽泛 allow 规则遮蔽。

- 匹配 `allowedExecutables` 的调用直接执行；
- 匹配 `approvalRequiredExecutables` 的调用使用 Agents SDK `needsApproval` 中断；
- 未匹配任一规则的调用返回 `command_not_allowed`；
- cwd 必须位于全局 workspaceRoot；
- 参数保持数组边界原样传递，不经过 shell 解释；
- timeout 到达后终止子进程并返回可重试的 `timeout`；
- 非零退出返回默认不可重试的 `process_failed`，分别保留受限 stdout 与 stderr；
- executable 在运行环境中不存在时返回 `dependency_missing`；
- 输出超过限制时终止子进程并返回 `output_limit_exceeded`。

权限判断先校验 workspace，再匹配命令规则。因此 workspace 外调用直接返回
`path_outside_workspace`，不会产生批准提示。对于需要确认的调用，`runAct` 从首次
`Runner.run()` 取得 interruption，调用 `state.approve()` 或 `state.reject()`，随后用
同一 state 恢复 Runner。批准只对当前调用生效，不设置 `alwaysApprove`。拒绝时传给
模型的是 `approval_rejected` 的 JSON error contract，而不是 SDK 默认文本。

应用层约束保证直接工具输入不指定 workspace 外 cwd，也不调用未授权 executable。某个
已授权程序自身若提供访问外部资源的功能，仍属于该程序的能力边界；首版不宣称提供
操作系统级 sandbox。

## Trace 协议

`TraceEvent` 增加五类事件：

- `tool_started`：timestamp、tool、operation 和清理后的 input summary；
- `tool_completed`：timestamp、tool、durationMs 和成功 evidence；
- `tool_failed`：timestamp、tool、durationMs，以及完整结构化 `ToolError`；
- `tool_approval_requested`：timestamp、tool、相对 cwd 和清理后的命令摘要；
- `tool_approval_resolved`：timestamp、tool、`approved` 布尔值和当前调用标识。

`tool_failed.error.retryable`、`type`、`userActionRequired`、`suggestedNextStep` 和
`evidence` 是 retry 审计依据。模型可见结果与 trace 事件引用同一个错误值，避免两个
分类路径逐渐漂移。现有 stage trace 保持不变；工具失败是 act 内的可处理结果，不自动
升级为 `stage_failed`。

需要确认的调用在执行前先写 `tool_approval_requested`。批准或拒绝后写
`tool_approval_resolved`；拒绝还写 `tool_failed`，其 `approval_rejected` error 与模型
看到的结构一致。这样 trace 能区分“策略拒绝”“用户拒绝”和“执行后失败”。

## 失败处理原则

已知 Node.js、`rg` 和子进程错误转换为稳定类型；无法识别的异常返回
`internal_error`，message 使用安全通用描述，原始堆栈不进入模型输出或 trace。参数
schema 错误由 adapter 转成 `invalid_input` 结果，而不是让 SDK 只返回异常字符串。

trace 写入失败不得被工具吞掉。审计链不完整时 wrapper 抛出该基础设施异常，让现有
stage 失败流程停止运行，而不是伪造一个可重试的业务工具错误。

## 测试与验收

离线单元测试使用临时 workspace 和内存 trace writer，至少覆盖：

- file read/write 成功、覆盖冲突、缺失路径、读取上限和越界；
- 通过符号链接读取或写入 workspace 外目标被拒绝；
- search 匹配、无匹配、无效正则、输出上限和相对路径；
- shell allowlist、参数数组、相对 cwd、非零退出、timeout、缺失 executable 和输出上限；
- shell 自动允许、请求批准、批准后恢复、拒绝后结构化返回，以及未匹配规则时拒绝；
- workspace 外调用不产生 approval request，且批准不能扩大 workspace 边界；
- 每种工具失败都向 Agent 返回完整 error contract；
- `tool_failed` trace 包含与返回值一致的 retry 依据；
- Actor Agent 注册文件、搜索和 shell 三个工具；
- 旧配置缺少 `tools` 时使用当前目录及其余默认值。

提交前运行：

```bash
npm test
npm run build
```

不设置 `RUN_LIVE_LOOP=1`，因此不会产生付费 API 调用。

## 验收标准

1. Agent 的每个工具失败输出都是可判别 JSON 结构，而不是裸 `stderr` 或异常文本。
2. 每个错误都包含 type、retryable、user action required、suggested next step 和 evidence。
3. 文件、搜索和 shell 共享一个可配置、默认当前目录的 workspace 权限根。
4. shell 仅执行自动允许或经当次用户批准的 executable/参数前缀规则，并使用参数数组。
5. retryable 及其分类证据写入 JSONL trace，并与 Agent 所见错误一致。
6. workspace 外调用始终拒绝，用户批准不能扩大 workspace 权限根。
7. 离线单元测试和 TypeScript build 通过。
