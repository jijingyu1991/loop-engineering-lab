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

const CODING_ALLOWED_EXECUTABLES: ExecutableRule[] = [
  { executable: "npm", argsPrefix: ["test"] },
  { executable: "npm", argsPrefix: ["run", "build"] },
  { executable: "git", argsPrefix: ["status"] },
  { executable: "rg", argsPrefix: [] },
];

/**
 * coding milestone 的只读承诺不能只依赖 Agent instructions。这里从通用 runtime
 * 派生一份独立策略，只保留本阶段明确需要的诊断前缀；尤其不能继承无参数前缀的
 * `node`，因为 `node -e` 可以任意写文件。默认 loop 继续使用原 runtime，行为不变。
 */
export function createCodingToolRuntimeConfig(
  runtime: ToolRuntimeConfig,
): ToolRuntimeConfig {
  return {
    ...runtime,
    file: { ...runtime.file },
    search: { ...runtime.search },
    shell: {
      allowedExecutables: CODING_ALLOWED_EXECUTABLES.map((rule) => ({
        executable: rule.executable,
        argsPrefix: [...rule.argsPrefix],
      })),
      // 本里程碑不会询问或恢复审批，因此不能把通用 loop 的 install/push
      // 审批规则暴露给 coding Agent；不在诊断白名单内的命令一律直接拒绝。
      approvalRequiredExecutables: [],
      timeoutMs: runtime.shell.timeoutMs,
      maxOutputChars: runtime.shell.maxOutputChars,
    },
  };
}
