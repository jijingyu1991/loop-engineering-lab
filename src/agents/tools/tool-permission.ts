import type { ExecutableRule } from "./tool-runtime-config.js";

export type ToolPermission = "allowed" | "approval_required" | "denied";

function matchesRule(
  input: { executable: string; args: string[] },
  rule: ExecutableRule,
): boolean {
  return (
    input.executable === rule.executable &&
    rule.argsPrefix.every((value, index) => input.args[index] === value)
  );
}

/**
 * 正常配置会拒绝 allowed 与 approval-required 重叠。这里仍优先检查审批规则，
 * 防止绕过 schema 的测试或调用方用宽泛 allow 规则意外遮蔽高风险子命令。
 */
export function resolveShellPermission(
  input: { executable: string; args: string[] },
  rules: {
    allowedExecutables: ExecutableRule[];
    approvalRequiredExecutables: ExecutableRule[];
  },
): ToolPermission {
  if (
    rules.approvalRequiredExecutables.some((rule) => matchesRule(input, rule))
  ) {
    return "approval_required";
  }

  if (rules.allowedExecutables.some((rule) => matchesRule(input, rule))) {
    return "allowed";
  }

  return "denied";
}
