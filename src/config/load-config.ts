import { readFile } from "node:fs/promises";

import {
  parseLoopConfig,
  resolveActiveModel,
  type LoadedLoopConfig,
} from "./config-schema.js";

/**
 * 文件系统访问被限制在这个小型适配器中，因此 schema 行为可以只用普通对象
 * 完成测试。CLI 通过本函数加载配置，而 domain 与 loop 代码无需知道配置实际
 * 存放在哪里。
 */
export async function loadLoopConfig(
  configPath: string,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<LoadedLoopConfig> {
  const json = await readFile(configPath, "utf8");
  const config = parseLoopConfig(JSON.parse(json) as unknown);

  return resolveActiveModel(config, environment);
}
