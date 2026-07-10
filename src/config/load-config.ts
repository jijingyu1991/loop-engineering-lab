import { readFile } from "node:fs/promises";

import {
  parseLoopConfig,
  resolveActiveModel,
  type LoadedLoopConfig,
} from "./config-schema.js";

/**
 * Filesystem access stays in this small adapter so schema behavior can be
 * tested with plain objects. The CLI uses this function; domain and loop code
 * never need to know where configuration was stored.
 */
export async function loadLoopConfig(
  configPath: string,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<LoadedLoopConfig> {
  const json = await readFile(configPath, "utf8");
  const config = parseLoopConfig(JSON.parse(json) as unknown);

  return resolveActiveModel(config, environment);
}
