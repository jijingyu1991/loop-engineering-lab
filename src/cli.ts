import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createActorAgent } from "./agents/create-agent.js";
import { createRunner } from "./agents/create-runner.js";
import { disableSdkTracing } from "./agents/disable-sdk-tracing.js";
import { createTerminalApprovalHandler } from "./agents/terminal-approval-handler.js";
import { createAgentTools } from "./agents/tools/create-agent-tools.js";
import { createToolOutcomeRecorder } from "./agents/tools/tool-outcome-recorder.js";
import { createToolRuntimeConfig } from "./agents/tools/tool-runtime-config.js";
import { loadLoopConfig } from "./config/load-config.js";
import type { LoopState } from "./domain/loop-state.js";
import { runLoop } from "./loop/loop-runner.js";
import { runAct } from "./loop/stages/act.js";
import { runConfiguredCodingMode } from "./modes/coding/run-configured-coding-mode.js";
import { createRunTraceWriter } from "./trace/create-run-trace-writer.js";

export type CliInvocation =
  | { mode: "loop"; request: string }
  | { mode: "coding"; request: string };

/**
 * `coding` 是显式子命令；其余输入继续走原有 loop 模式，避免改变既有脚本调用。
 * 两条路径分别保留清晰的 usage，使缺少自然语言请求时在任何 runtime 创建前失败。
 */
export function parseCliInvocation(args: string[]): CliInvocation {
  if (args[0] === "coding") {
    const request = args.slice(1).join(" ").trim();
    if (!request) {
      throw new Error('Usage: npm run loop -- coding "your request"');
    }

    return { mode: "coding", request };
  }

  const request = args.join(" ").trim();
  if (!request) {
    throw new Error('Usage: npm run loop -- "your task"');
  }

  return { mode: "loop", request };
}

/**
 * 在入口处一次性组装基础设施，再把小而明确的依赖交给 loop。这里是唯一了解
 * 配置文件、环境变量和具体 Agents SDK 类的地方，业务编排无需依赖这些细节。
 */
export async function runConfiguredLoop(
  task: string,
  configPath = resolve(process.cwd(), "config/loop.config.json"),
): Promise<LoopState> {
  // 在构造任何 Agent runtime 之前禁用 SDK 的进程级 exporter。下方使用的
  // 本地 JSONL trace 是一套独立实现，不受该开关影响。
  disableSdkTracing();

  const loaded = await loadLoopConfig(configPath, process.env);
  const runner = createRunner(loaded.modelConfig, loaded.apiKey);
  const { writer: traceWriter } = await createRunTraceWriter({
    basePath: resolve(process.cwd(), loaded.config.tracePath),
    maxFiles: 20,
  });
  const toolRuntime = createToolRuntimeConfig(loaded.config, process.cwd());
  const outcomeRecorder = createToolOutcomeRecorder();
  const tools = createAgentTools(toolRuntime, traceWriter, outcomeRecorder);
  const agent = createActorAgent(loaded.modelConfig, tools);
  const approvalHandler = createTerminalApprovalHandler({
    input: process.stdin,
    // 审批提示写 stderr，避免破坏 stdout 中供脚本消费的最终 JSON。
    output: process.stderr,
    isTTY: Boolean(process.stdin.isTTY),
  });

  return runLoop({
    task,
    activeModel: loaded.activeModelName,
    maxSteps: loaded.config.safetyLimits.maxSteps,
    maxTurns: loaded.config.safetyLimits.maxTurns,
    traceWriter,
    act: ({ observation, plan, maxTurns }) =>
      runAct({
        runner,
        agent,
        observation,
        plan,
        maxTurns,
        traceWriter,
        approvalHandler,
        outcomeRecorder,
      }),
  });
}

async function main(): Promise<void> {
  const invocation = parseCliInvocation(process.argv.slice(2));

  if (invocation.mode === "coding") {
    const result = await runConfiguredCodingMode(invocation.request);
    console.log(JSON.stringify(result, null, 2));

    // blocked/cancelled 是可解释的 workflow 终态，不应被 CLI 伪装成 runtime crash。
    if (result.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  const state = await runConfiguredLoop(invocation.request);
  console.log(
    JSON.stringify(
      {
        status: state.status,
        stopReason: state.stopReason,
        completedSteps: state.steps.length,
        finalOutput: state.steps.at(-1)?.act.data?.output ?? null,
      },
      null,
      2,
    ),
  );

  if (state.status === "failed") {
    process.exitCode = 1;
  }
}

const isExecutedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Loop failed: ${message}`);
    process.exitCode = 1;
  });
}
