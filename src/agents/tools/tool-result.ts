import type {
  ToolError,
  ToolEvidence,
} from "../../domain/tool-error.js";

export type {
  ToolError,
  ToolErrorType,
  ToolEvidence,
} from "../../domain/tool-error.js";

/**
 * 失败也是正常工具返回值。这样 Agents SDK 会把完整结构交给模型，而不是捕获异常后
 * 退化成一段不可判别的错误文本。
 */
export type ToolResult<T> =
  | { ok: true; data: T; evidence: ToolEvidence }
  | { ok: false; error: ToolError };

export function createToolError(error: ToolError): ToolError {
  return error;
}
