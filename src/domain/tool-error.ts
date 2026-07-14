/**
 * 工具错误类型属于 loop 的领域协议，而不是 Agents SDK adapter 的私有类型。
 * 把它放在 domain 后，ActData、trace 和具体工具可以共享同一份定义，同时保持
 * 上层状态机不依赖某个 provider 的实现。
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

/** 只允许 JSON-safe 的小型证据值，避免异常对象或无界输出进入持久状态。 */
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
