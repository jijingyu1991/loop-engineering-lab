import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelRetryAdviceRequest,
} from "@openai/agents";

function withJsonObjectOutput(request: ModelRequest): ModelRequest {
  if (request.outputType === "text") return request;

  const jsonObjectInstructions = [
    "DeepSeek JSON Object compatibility instructions:",
    "Tool calls take priority over final JSON output. If the task requires a tool, call it before producing final JSON.",
    "Return only one JSON object when producing the final assistant answer instead of calling a tool.",
    `The final JSON must match this JSON Schema exactly: ${JSON.stringify(request.outputType.schema)}`,
    'Example JSON: {"output":"useful action result","outcome":"succeeded"}',
    "Do not return the schema itself, wrap the object in Markdown, or omit required properties.",
  ].join("\n");

  return {
    ...request,
    // JSON Object 只保证语法合法，不会像 JSON Schema 模式一样由服务端约束字段。
    // 因此必须把被降级的 schema 留在 system prompt 中，让 DeepSeek 在最终回答
    // 阶段仍知道精确字段；“instead of calling a tool” 则保留正常 tool-call 路径。
    systemInstructions: request.systemInstructions
      ? `${request.systemInstructions}\n\n${jsonObjectInstructions}`
      : jsonObjectInstructions,
    /**
     * Agents SDK 的公开类型目前只描述 `text` 与 `json_schema`，但它自己的
     * Chat Completions adapter 会把其他对象形式映射为 `json_object`。DeepSeek
     * 只接受后者，因此这里把 provider 边界上的请求副本改成兼容标记；Agent
     * 本身仍保留原始 Zod outputType，最终输出依旧由 Runner 解析和校验。
     *
     * 类型收窄刻意限制在这一行，避免 DeepSeek 的协议差异泄漏到 loop 层。
     */
    outputType: { type: "json_object" } as unknown as ModelRequest["outputType"],
  };
}

class JsonObjectModel implements Model {
  public constructor(private readonly delegate: Model) {}

  public getResponse(request: ModelRequest) {
    return this.delegate.getResponse(withJsonObjectOutput(request));
  }

  public getStreamedResponse(request: ModelRequest) {
    return this.delegate.getStreamedResponse(withJsonObjectOutput(request));
  }

  public getRetryAdvice(request: ModelRetryAdviceRequest) {
    return this.delegate.getRetryAdvice?.(request);
  }
}

/**
 * 为只支持 JSON Object 的 OpenAI-compatible Chat Completions provider
 * 提供最小适配，同时保持底层 model 的网络、流式和重试行为不变。
 */
export function createJsonObjectModelProvider(
  delegate: ModelProvider,
): ModelProvider {
  return {
    getModel: async (modelName) =>
      new JsonObjectModel(await delegate.getModel(modelName)),
  };
}
