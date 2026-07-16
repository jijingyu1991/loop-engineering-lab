import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runConfiguredCodingMode } from "./modes/coding/run-configured-coding-mode.js";

/**
 * 独立入口中的全部参数都属于自然语言请求，不再保留子命令槽位。这里先完成规范化和
 * 空输入校验，确保无效调用不会提前创建模型、工具或 trace 等 runtime 资源。
 */
export function parseCodingRequest(args: string[]): string {
  const request = args.join(" ").trim();
  if (!request) {
    throw new Error('Usage: npm run coding -- "your request"');
  }

  return request;
}

async function main(): Promise<void> {
  const request = parseCodingRequest(process.argv.slice(2));
  const result = await runConfiguredCodingMode(request);
  console.log(JSON.stringify(result, null, 2));

  // blocked/cancelled 是可解释的 workflow 终态；只有 failed 才表示进程执行失败。
  if (result.status === "failed") {
    process.exitCode = 1;
  }
}

const isExecutedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Coding failed: ${message}`);
    process.exitCode = 1;
  });
}
