import type { ExecutableRule } from "./tool-runtime-config.js";

export type ToolPermission = "allowed" | "approval_required" | "denied";

function matchesRule(
  input: { executable: string; args: string[] },
  rule: ExecutableRule,
): boolean {
  const prefixMatches =
    input.executable === rule.executable &&
    rule.argsPrefix.every((value, index) => input.args[index] === value);

  // 未声明 argsMatch 的所有既有规则继续采用 prefix 匹配；只有 composition
  // 显式标记 exact 时，参数数量也必须相等，从能力边界阻断尾参数逃逸。
  return prefixMatches &&
    (rule.argsMatch !== "exact" || input.args.length === rule.argsPrefix.length);
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
