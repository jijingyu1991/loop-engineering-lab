import { runWorkflow } from "../../runtime/run-workflow.js";
import type { WorkflowStatus } from "../../runtime/workflow-types.js";
import type {
  CodingRunStoppedEvent,
  TraceEvent,
} from "../../trace/trace-event.js";
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { createCodingWorkflow } from "./create-coding-workflow.js";
import type {
  CodingExecutor,
  CodingReviewer,
  CodingRunResult,
  CodingStopReason,
} from "./coding-state.js";
import type {
  CodingClassifier,
  CodingTaskType,
} from "./coding-task.js";

const CODING_STOP_REASONS = new Set<CodingStopReason>([
  "explanation_completed",
  "related_files_identified",
  "diagnosis_completed",
  "implementation_plan_completed",
  "classification_failed",
  "workflow_step_failed",
  "max_workflow_steps_exceeded",
  "tool_error",
  "user_action_required",
  "approval_required",
  "approval_rejected",
  "context_budget_exceeded",
  "reviewer_failed",
  "reviewer_timed_out",
  "runtime_error",
]);

function mapStopReason(reason: string): CodingStopReason {
  return CODING_STOP_REASONS.has(reason as CodingStopReason)
    ? reason as CodingStopReason
    : "runtime_error";
}

function mapWorkflowTerminal(input: {
  status: WorkflowStatus;
  stopReason: string;
}): { status: WorkflowStatus; stopReason: CodingStopReason } {
  const stopReason = mapStopReason(input.stopReason);

  // 未知 reason 表示运行时数据已经越过静态合同。此时即便上游错误地携带
  // completed/cancelled，也必须降级为 failed，避免产生自相矛盾的成功终态。
  return {
    status: stopReason === "runtime_error" ? "failed" : input.status,
    stopReason,
  };
}

function createTerminal(input: {
  timestamp: string;
  status: WorkflowStatus;
  taskType: CodingTaskType | null;
  stopReason: CodingStopReason;
  completedSteps: number;
  finalOutput: string | null;
  tracePath: string;
}): { event: CodingRunStoppedEvent; result: CodingRunResult } {
  // event 与返回值从同一组字段构造，避免某条失败分支只更新其中一份而造成审计不一致。
  const terminal = {
    status: input.status,
    taskType: input.taskType,
    stopReason: input.stopReason,
    completedSteps: input.completedSteps,
  };

  return {
    event: {
      event: "coding_run_stopped",
      timestamp: input.timestamp,
      ...terminal,
    },
    result: {
      ...terminal,
      finalOutput: input.finalOutput,
      tracePath: input.tracePath,
    },
  };
}

export async function runCodingMode(input: {
  request: string;
  activeModel: string;
  tracePath: string;
  maxSteps: number;
  traceWriter: TraceWriter;
  classifier: CodingClassifier;
  executor: CodingExecutor;
  reviewer?: CodingReviewer;
  traceSnapshot?: () => readonly TraceEvent[];
  now?: () => string;
}): Promise<CodingRunResult> {
  const request = input.request.trim();
  if (!request) {
    throw new Error("Coding request must not be empty");
  }
  // 与 request 一样，运行安全边界必须在 start trace 前验证。否则无效配置会留下
  // 一个已经启动、却永远没有 terminal event 的虚假运行记录。
  if (!Number.isInteger(input.maxSteps) || input.maxSteps <= 0) {
    throw new RangeError("maxSteps must be a positive integer");
  }

  const now = input.now ?? (() => new Date().toISOString());
  await input.traceWriter.write({
    event: "coding_run_started",
    timestamp: now(),
    request,
    mode: "coding",
    activeModel: input.activeModel,
  });

  if (input.reviewer === undefined || input.traceSnapshot === undefined) {
    // Task 5 到 Task 6 的组合过渡期允许旧 composition 暂未注入 reviewer，但只能
    // fail-closed。这里在任何模型调用前终止，既不产生费用，也绝不让 executor 摘要
    // 绕过语义审查成为成功输出；Task 6 会在进程边界提供真实依赖。
    const terminal = createTerminal({
      timestamp: now(),
      status: "failed",
      taskType: null,
      stopReason: "reviewer_failed",
      completedSteps: 0,
      finalOutput: null,
      tracePath: input.tracePath,
    });
    await input.traceWriter.write(terminal.event);
    return terminal.result;
  }

  let classification;
  try {
    // catch 的边界只包住 classifier。若 coding trace 写入失败，必须直接 reject，
    // 不能把审计设施故障伪装成一次普通的分类失败。
    classification = await input.classifier(request);
  } catch {
    const terminal = createTerminal({
      timestamp: now(),
      status: "failed",
      taskType: null,
      stopReason: "classification_failed",
      completedSteps: 0,
      finalOutput: null,
      tracePath: input.tracePath,
    });
    await input.traceWriter.write(terminal.event);
    return terminal.result;
  }

  await input.traceWriter.write({
    event: "coding_task_classified",
    timestamp: now(),
    classification,
  });

  const workflowResult = await runWorkflow({
    definition: createCodingWorkflow({
      taskType: classification.taskType,
      executor: input.executor,
      reviewer: input.reviewer,
      traceWriter: input.traceWriter,
      traceSnapshot: input.traceSnapshot,
      now,
    }),
    initialState: {
      request,
      classification,
      output: null,
      evidence: [],
      attempt: 0,
      revisionInstructions: [],
    },
    maxSteps: input.maxSteps,
    traceWriter: input.traceWriter,
    now,
  });
  const mappedTerminal = mapWorkflowTerminal({
    status: workflowResult.status,
    stopReason: workflowResult.stopReason,
  });
  const terminal = createTerminal({
    timestamp: now(),
    status: mappedTerminal.status,
    taskType: classification.taskType,
    stopReason: mappedTerminal.stopReason,
    completedSteps: workflowResult.completedSteps,
    finalOutput: workflowResult.state.output,
    tracePath: input.tracePath,
  });

  await input.traceWriter.write(terminal.event);
  return terminal.result;
}
