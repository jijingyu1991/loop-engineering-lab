import { z } from "zod";

/**
 * The API choice is part of model configuration rather than inferred from the
 * model name. That keeps provider behavior explicit: a future alias can point
 * at a different endpoint without adding another `if (modelName === ...)` in
 * application code.
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
 * Resolve the selected model and credential once at the composition boundary.
 *
 * The API key deliberately lives outside `LoopConfig`. LoopConfig is safe to
 * pass to trace/debug code; the returned `apiKey` is instead handed directly
 * to the Agent provider factory. This separation makes accidental credential
 * serialization much less likely.
 */
export function resolveActiveModel(
  config: LoopConfig,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): LoadedLoopConfig {
  const modelConfig = config.models[config.activeModel];

  // The schema checks this relation. Keeping the runtime guard makes this
  // function safe even if callers eventually construct LoopConfig manually.
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
