import { z } from "zod";

/**
 * API 类型是模型配置的一部分，而不是根据模型名推断出来的。这样可以显式表达
 * provider 的行为：未来即使某个别名改为指向其他端点，也不需要在业务代码中
 * 再添加一条 `if (modelName === ...)` 判断。
 */
export const modelConfigSchema = z.object({
  model: z.string().min(1),
  baseURL: z.url(),
  apiKeyEnv: z.string().min(1),
  api: z.enum(["responses", "chat_completions"]),
  // Reviewer 需要生成带证据引用的严格结构化结果，延迟特征可能与主 Agent 不同。
  // 预算放在模型配置而不是按 API 类型推断，使不同 provider 可以独立调优；默认值
  // 保持旧配置与原有 15 秒行为兼容。
  reviewerTimeoutMs: z.number().int().positive().default(15_000),
});

const executableRuleSchema = z.object({
  executable: z.string().min(1),
  argsPrefix: z.array(z.string()).default([]),
});

const defaultAllowedExecutables = [
  { executable: "node", argsPrefix: [] },
  { executable: "npm", argsPrefix: ["test"] },
  { executable: "npm", argsPrefix: ["run", "build"] },
  { executable: "git", argsPrefix: ["status"] },
  { executable: "rg", argsPrefix: [] },
];

const defaultApprovalRequiredExecutables = [
  { executable: "npm", argsPrefix: ["install"] },
  { executable: "git", argsPrefix: ["push"] },
];

const shellToolConfigSchema = z
  .object({
    allowedExecutables: z
      .array(executableRuleSchema)
      .default(defaultAllowedExecutables),
    approvalRequiredExecutables: z
      .array(executableRuleSchema)
      .default(defaultApprovalRequiredExecutables),
    timeoutMs: z.number().int().positive().default(10_000),
    maxOutputChars: z.number().int().positive().default(20_000),
  })
  .prefault({});

const toolsConfigSchema = z
  .object({
    workspaceRoot: z.string().min(1).default("."),
    shell: shellToolConfigSchema,
    search: z
      .object({
        maxMatches: z.number().int().positive().default(200),
        maxOutputChars: z.number().int().positive().default(20_000),
      })
      .prefault({}),
    file: z
      .object({
        maxReadChars: z.number().int().positive().default(100_000),
      })
      .prefault({}),
  })
  .prefault({});

function isPrefix(left: string[], right: string[]): boolean {
  return (
    left.length <= right.length &&
    left.every((value, index) => value === right[index])
  );
}

export const loopConfigSchema = z
  .object({
    activeModel: z.string().min(1),
    models: z.record(z.string(), modelConfigSchema),
    safetyLimits: z.object({
      maxSteps: z.number().int().positive(),
      maxTurns: z.number().int().positive(),
    }),
    tracePath: z.string().min(1),
    tools: toolsConfigSchema,
  })
  .superRefine((value, context) => {
    if (!value.models[value.activeModel]) {
      context.addIssue({
        code: "custom",
        path: ["activeModel"],
        message: `Unknown activeModel: ${value.activeModel}`,
      });
    }

    for (const allowed of value.tools.shell.allowedExecutables) {
      for (const approval of value.tools.shell.approvalRequiredExecutables) {
        if (
          allowed.executable === approval.executable &&
          (isPrefix(allowed.argsPrefix, approval.argsPrefix) ||
            isPrefix(approval.argsPrefix, allowed.argsPrefix))
        ) {
          context.addIssue({
            code: "custom",
            path: ["tools", "shell"],
            message: [
              "Ambiguous shell permission rules:",
              allowed.executable,
              allowed.argsPrefix.join(" "),
              "overlaps",
              approval.argsPrefix.join(" "),
            ].join(" "),
          });
        }
      }
    }
  });

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type LoopConfig = z.infer<typeof loopConfigSchema>;

export interface LoadedLoopConfig {
  config: LoopConfig;
  activeModelName: string;
  modelConfig: ModelConfig;
  apiKey: string;
}

export function parseLoopConfig(raw: unknown): LoopConfig {
  return loopConfigSchema.parse(raw);
}

/**
 * 在组合边界一次性解析当前选中的模型和凭据。
 *
 * API key 被有意放在 `LoopConfig` 之外，因此可以安全地把 LoopConfig 交给
 * trace 或调试代码；返回的 `apiKey` 则直接传给 Agent provider 工厂。这种隔离
 * 能显著降低凭据被意外序列化的风险。
 */
export function resolveActiveModel(
  config: LoopConfig,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): LoadedLoopConfig {
  const modelConfig = config.models[config.activeModel];

  // schema 已经检查了这层对应关系。这里仍保留运行时防护，确保未来调用方即使
  // 绕过 schema、手动构造 LoopConfig，本函数也能安全失败并给出明确错误。
  if (!modelConfig) {
    throw new Error(`Unknown activeModel: ${config.activeModel}`);
  }

  const apiKey = environment[modelConfig.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `Missing API key environment variable: ${modelConfig.apiKeyEnv}`,
    );
  }

  return {
    config,
    activeModelName: config.activeModel,
    modelConfig,
    apiKey,
  };
}
