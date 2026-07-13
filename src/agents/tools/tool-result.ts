/**
 * 工具错误使用稳定的业务分类，而不是把 Node.js error code 或 stderr 当作协议。
 * Agent 可以据此决定重试、请求用户操作或改用其他工具；底层实现细节则只作为
 * 已清理的 evidence 保留。
 */
export type ToolErrorType =
  | "invalid_input"
  | "path_outside_workspace"
  | "not_found"
  | "permission_denied"
  | "conflict"
  | "command_not_allowed"
  | "approval_required"
  | "approval_rejected"
  | "dependency_missing"
  | "timeout"
  | "process_failed"
  | "output_limit_exceeded"
  | "internal_error";

/** 只允许 JSON-safe 的小型证据值，避免把异常对象或无限输出写入 trace。 */
export type ToolEvidence = Record<
  string,
  string | number | boolean | null | string[]
>;

export interface ToolError {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  userActionRequired: boolean;
  suggestedNextStep: string;
  evidence: ToolEvidence;
}

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
