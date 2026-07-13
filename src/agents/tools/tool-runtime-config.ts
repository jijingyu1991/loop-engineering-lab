import { resolve } from "node:path";

import type { LoopConfig } from "../../config/config-schema.js";

export interface ExecutableRule {
  executable: string;
  argsPrefix: string[];
}

export interface ToolRuntimeConfig {
  workspaceRoot: string;
  file: { maxReadChars: number };
  search: { maxMatches: number; maxOutputChars: number };
  shell: {
    allowedExecutables: ExecutableRule[];
    approvalRequiredExecutables: ExecutableRule[];
    timeoutMs: number;
    maxOutputChars: number;
  };
}

/**
 * 配置文件保留便于迁移的相对路径，只有 composition root 创建 runtime 时才解析
 * 绝对 workspace。三个工具共享这一个结果，避免出现各自基于不同 cwd 的权限边界。
 */
export function createToolRuntimeConfig(
  config: LoopConfig,
  currentWorkingDirectory = process.cwd(),
): ToolRuntimeConfig {
  return {
    workspaceRoot: resolve(currentWorkingDirectory, config.tools.workspaceRoot),
    file: { ...config.tools.file },
    search: { ...config.tools.search },
    shell: {
      allowedExecutables: config.tools.shell.allowedExecutables.map((rule) => ({
        executable: rule.executable,
        argsPrefix: [...rule.argsPrefix],
      })),
      approvalRequiredExecutables:
        config.tools.shell.approvalRequiredExecutables.map((rule) => ({
          executable: rule.executable,
          argsPrefix: [...rule.argsPrefix],
        })),
      timeoutMs: config.tools.shell.timeoutMs,
      maxOutputChars: config.tools.shell.maxOutputChars,
    },
  };
}
