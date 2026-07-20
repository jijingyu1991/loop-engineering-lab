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
import { runSubagent } from "../../subagents/run-subagent.js";
import { createReviewerAgent } from "../../subagents/reviewer/create-reviewer-agent.js";
import {
  createReviewerAgentContract,
  validateReviewerAgentCompletedResult,
} from "../../subagents/reviewer/reviewer-contract.js";
import { runReviewerAgent } from "../../subagents/reviewer/run-reviewer-agent.js";
import { createRunTraceWriter } from "../../trace/create-run-trace-writer.js";
import { RecordingTraceWriter } from "../../trace/recording-trace-writer.js";
import {
  classifyCodingRequest,
  createCodingClassifierAgent,
} from "./coding-classifier.js";
import type { CodingRunResult } from "./coding-state.js";
import { createCodingAgent } from "./create-coding-agent.js";
import { runCodingAgent } from "./run-coding-agent.js";
import { runCodingMode } from "./run-coding-mode.js";

/**
 * 组装 executor 的完整提示词，同时保留用户原始请求和分类依据。
 *
 * revision instructions 是 reviewer 对上一次尝试的增量约束，必须作为独立段落
 * 出现，避免与固定 workflow instructions 混合后失去来源；首次执行没有反馈时则
 * 完全省略该段，防止 Agent 误以为存在一次尚未发生的审查。
 */
export function createCodingExecutorPrompt(input: {
  request: string;
  objective: string;
  classificationReason: string;
  workflowInstructions: string;
  revisionInstructions: string[];
}): string {
  const sections = [
    `Raw request:\n${input.request}`,
    `Normalized objective:\n${input.objective}`,
    `Classification reason:\n${input.classificationReason}`,
    `Workflow instructions:\n${input.workflowInstructions}`,
  ];
  if (input.revisionInstructions.length > 0) {
    // join 只读取调用方数组，不排序、不 splice；workflow 保有自己的反馈顺序，
    // 同一顺序也进入 prompt，便于后续 trace 与 reviewer 建议逐项核对。
    sections.push(
      `Reviewer revision instructions:\n${input.revisionInstructions.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

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
  // 文件 writer 成功创建后立即包成唯一 journal，且必须早于任何工具或 Agent
  // adapter 的构造。这样工具结果、executor、workflow 和 subagent 生命周期先落盘，
  // 再按同一顺序进入 reviewer 可见快照；落盘失败会原样 reject，不产生内存幻象。
  const traceJournal = new RecordingTraceWriter(traceWriter);
  const runner = createRunner(loaded.modelConfig, loaded.apiKey);
  const toolRuntime = createCodingToolRuntimeConfig(
    createToolRuntimeConfig(loaded.config, process.cwd()),
  );
  const outcomeRecorder = createToolOutcomeRecorder();
  const tools = createCodingTools(toolRuntime, traceJournal, outcomeRecorder);
  const classifierAgent = createCodingClassifierAgent(loaded.modelConfig);
  const codingAgent = createCodingAgent(loaded.modelConfig, tools);
  // reviewer Agent 在 SDK 层固定 tools: []，与 Contract 的 allowedTools: [] 双重一致；
  // 它只能消费冻结 trace 与 summary，不能借用 coding tools 退化成第二个 executor。
  const reviewerAgent = createReviewerAgent(loaded.modelConfig);
  const maxTurns = loaded.config.safetyLimits.maxTurns;
  // 同一 composition clock 同时服务 workflow 与 Agent interruption，避免一次运行
  // 的 terminal/approval 事件由不同时间源生成而破坏确定性测试与审计排序。
  const now = () => new Date().toISOString();

  return runCodingMode({
    request,
    activeModel: loaded.activeModelName,
    tracePath,
    maxSteps: loaded.config.safetyLimits.maxSteps,
    traceWriter: traceJournal,
    traceSnapshot: () => traceJournal.snapshot(),
    now,
    classifier: (rawRequest) =>
      classifyCodingRequest(runner, classifierAgent, rawRequest, maxTurns),
    executor: ({
      request: rawRequest,
      classification,
      instructions,
      revisionInstructions,
    }) => {
      const prompt = createCodingExecutorPrompt({
        request: rawRequest,
        objective: classification.objective,
        classificationReason: classification.reason,
        workflowInstructions: instructions,
        revisionInstructions,
      });

      return runCodingAgent({
        runner,
        agent: codingAgent,
        prompt,
        maxTurns,
        traceWriter: traceJournal,
        now,
      });
    },
    reviewer: async ({ attempt, trace, summary }) => {
      // workflow 在 coding_execution_completed 持久化后传入冻结快照；Contract 将完整
      // trace 和 summary 作为仅有上下文，并由 maxChars 边界拒绝超限而非静默截断。
      const contract = createReviewerAgentContract({ attempt, trace, summary });
      const result = await runSubagent({
        contract,
        traceWriter: traceJournal,
        now,
        invoker: (invocation) => runReviewerAgent({
          ...invocation,
          runner,
          agent: reviewerAgent,
        }),
        validateCompletedResult: (validatedContract, completedResult) =>
          validateReviewerAgentCompletedResult(
            validatedContract,
            completedResult,
            trace.length,
          ),
      });
      if (result.status === "completed") {
        // runSubagent 已执行同一校验；再次解析只用于把统一 envelope 收窄为角色判别联合。
        // trace.length 来自创建 Contract 的冻结快照，后续 lifecycle event 不得扩大引用范围。
        return validateReviewerAgentCompletedResult(contract, result, trace.length);
      }
      // Zod 产出的通用 SubagentResult 是可变对象，TypeScript 不会在直接 return 时保留
      // status 属性的排除式收窄；复制 envelope 并显式覆盖判别字段，不改变运行时内容，
      // 同时保证 reviewer callback 只能返回 unsuccessful 联合中的三个状态。
      return { ...result, status: result.status };
    },
  });
}
