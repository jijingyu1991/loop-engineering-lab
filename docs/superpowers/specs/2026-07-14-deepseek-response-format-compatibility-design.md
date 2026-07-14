# DeepSeek response_format 兼容设计

## 背景与目标

当前 Actor 使用 Zod `actorOutputSchema` 作为 Agents SDK 的 `outputType`。SDK 在 Chat Completions 请求中把它序列化为 `response_format.type = "json_schema"`，但 DeepSeek Chat Completions 只接受 `text` 或 `json_object`，导致模型在生成任何工具调用前返回 HTTP 400。

本次修复的目标是：DeepSeek 请求使用 `json_object`，同时保留 Agent 现有的 Zod 最终输出解析与校验，并且不改变 GPT Responses、工具审批或 loop 阶段编排行为。

## 选定方案

在 model provider 边界增加一个小型兼容包装器。包装器代理 SDK model，仅在以下条件同时成立时改写传入 model 的请求：

- provider 配置为 `chat_completions`；
- SDK 请求的结构化输出类型为 `json_schema`。

改写后的 model 请求携带一个兼容标记，使 OpenAI Chat Completions model 生成 `response_format: { "type": "json_object" }`。原始 Agent 仍持有 Zod `actorOutputSchema`，所以 Runner 收到最终 JSON 文本后仍通过现有 SDK 路径执行 `JSON.parse` 和 Zod 校验。

不采用把 Actor 全面改为文本输出的方案，因为那会把 JSON 解析、类型收窄和终止语义带入 `runAct`，扩大 provider 差异对 loop 层的影响。

## 组件边界与数据流

`createModelProvider` 继续负责从项目配置构造 provider。DeepSeek/Chat Completions 分支返回兼容 provider；Responses 分支返回原有 provider，不做改写。

数据流如下：

1. Runner 根据 Agent 的 Zod `outputType` 创建 `json_schema` model request。
2. 兼容 model 复制该 request，并把仅供 Chat Completions adapter 使用的输出格式改为 `json_object`。
3. SDK 向 DeepSeek 发送 `response_format.type = "json_object"`。
4. DeepSeek 返回合法 JSON 字符串。
5. Runner 依据 Agent 原始 Zod `outputType` 解析并校验 `{ output, outcome }`。
6. `runAct` 继续消费已验证的结构化结果；Shell 工具调用和审批 interruption 保持不变。

包装器不得修改调用方传入的 request 对象，避免重试或其他 provider 复用时泄漏状态。

## 错误处理

兼容层只处理已确认的格式差异，不吞掉或重写 DeepSeek API 异常。模型返回无效 JSON 或不符合 `actorOutputSchema` 时，仍由 Agents SDK 按现有行为报错。文本输出请求和未知输出类型保持原样代理。

## 测试与验收

单元测试覆盖：

- Chat Completions provider 将 `json_schema` 请求改写为 DeepSeek 可接受的 `json_object` 形式；
- 改写不修改原始 request；
- Responses provider 不启用兼容包装器；
- 现有 provider 配置映射测试继续通过。

完成后运行 `npm test` 和 `npm run build`。真实 API 集成测试不默认运行，避免凭据依赖和付费调用。修复的验收标准是 DeepSeek 首次 model request 不再因 `response_format.type = "json_schema"` 返回 400，从而允许模型继续生成 `workspace_shell` 调用并进入既有审批流程。

## 范围限制

本次不修改 DeepSeek model 名称、API 凭据、Shell 权限规则、终端审批 UI 或 trace schema，也不引入新的第三方依赖。
