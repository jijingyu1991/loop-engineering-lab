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
});

export const loopConfigSchema = z
  .object({
    activeModel: z.string().min(1),
    models: z.record(z.string(), modelConfigSchema),
    safetyLimits: z.object({
      maxSteps: z.number().int().positive(),
      maxTurns: z.number().int().positive(),
    }),
    tracePath: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (!value.models[value.activeModel]) {
      context.addIssue({
        code: "custom",
        path: ["activeModel"],
        message: `Unknown activeModel: ${value.activeModel}`,
      });
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
