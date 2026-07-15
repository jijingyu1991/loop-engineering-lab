import { resolve } from "node:path";

import { createRunner } from "../../agents/create-runner.js";
import { disableSdkTracing } from "../../agents/disable-sdk-tracing.js";
import { createCodingTools } from "../../agents/tools/create-coding-tools.js";
import { createToolOutcomeRecorder } from "../../agents/tools/tool-outcome-recorder.js";
import {
  createCodingToolRuntimeConfig,
  createToolRuntimeConfig,
} from "../../agents/tools/tool-runtime-config.js";
import { loadLoopConfig } from "../../config/load-config.js";
import { createRunTraceWriter } from "../../trace/create-run-trace-writer.js";
import {
  classifyCodingRequest,
  createCodingClassifierAgent,
} from "./coding-classifier.js";
import type { CodingRunResult } from "./coding-state.js";
import { createCodingAgent } from "./create-coding-agent.js";
import { runCodingAgent } from "./run-coding-agent.js";
import { runCodingMode } from "./run-coding-mode.js";

/**
 * 把配置、SDK adapter、只读工具和 coding workflow 集中装配在进程边界。
 * 领域 workflow 只接收 classifier/executor 闭包，因此不会感知配置文件、API key
 * 或具体 Agent 实现；同时这里明确使用 createCodingTools，保证 writable file tool
 * 不会进入 coding Agent。
 */
export async function runConfiguredCodingMode(
  request: string,
  configPath = resolve(process.cwd(), "config/loop.config.json"),
): Promise<CodingRunResult> {
  // SDK exporter 是进程级状态，必须在创建 Runner/Agent 之前关闭；本地 JSONL
  // trace 与 SDK tracing 相互独立，仍会完整记录本次 coding run。
  disableSdkTracing();

  const loaded = await loadLoopConfig(configPath, process.env);
  const { writer: traceWriter, tracePath } = await createRunTraceWriter({
    basePath: resolve(process.cwd(), loaded.config.tracePath),
    maxFiles: 20,
  });
  const runner = createRunner(loaded.modelConfig, loaded.apiKey);
  const toolRuntime = createCodingToolRuntimeConfig(
    createToolRuntimeConfig(loaded.config, process.cwd()),
  );
  const outcomeRecorder = createToolOutcomeRecorder();
  const tools = createCodingTools(toolRuntime, traceWriter, outcomeRecorder);
  const classifierAgent = createCodingClassifierAgent(loaded.modelConfig);
  const codingAgent = createCodingAgent(loaded.modelConfig, tools);
  const maxTurns = loaded.config.safetyLimits.maxTurns;
  // 同一 composition clock 同时服务 workflow 与 Agent interruption，避免一次运行
  // 的 terminal/approval 事件由不同时间源生成而破坏确定性测试与审计排序。
  const now = () => new Date().toISOString();

  return runCodingMode({
    request,
    activeModel: loaded.activeModelName,
    tracePath,
    maxSteps: loaded.config.safetyLimits.maxSteps,
    traceWriter,
    now,
    classifier: (rawRequest) =>
      classifyCodingRequest(runner, classifierAgent, rawRequest, maxTurns),
    executor: ({
      request: rawRequest,
      classification,
      instructions,
    }) => {
      // raw request 保留用户原始语境，objective/reason 固化分类依据，workflow
      // instructions 则限定当前任务类型的交付格式；四部分都进入同一次 Agent 调用。
      const prompt = [
        `Raw request:\n${rawRequest}`,
        `Normalized objective:\n${classification.objective}`,
        `Classification reason:\n${classification.reason}`,
        `Workflow instructions:\n${instructions}`,
      ].join("\n\n");

      return runCodingAgent({
        runner,
        agent: codingAgent,
        prompt,
        maxTurns,
        traceWriter,
        now,
      });
    },
  });
}
