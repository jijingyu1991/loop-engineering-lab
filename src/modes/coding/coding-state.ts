import type {
  WorkflowEvidence,
  WorkflowStatus,
} from "../../runtime/workflow-types.js";
import type { ReviewerAgentRunResult } from "../../subagents/reviewer/reviewer-contract.js";
import type { TraceEvent } from "../../trace/trace-event.js";
import type { CodingTaskClassification } from "./coding-task.js";

// stop reason 同时覆盖正常终止和异常终止，便于 trace 与调用方使用稳定、可枚举的值。
export type CodingStopReason =
  | "explanation_completed"
  | "related_files_identified"
  | "diagnosis_completed"
  | "implementation_plan_completed"
  | "classification_failed"
  | "workflow_step_failed"
  | "max_workflow_steps_exceeded"
  | "tool_error"
  | "user_action_required"
  | "approval_required"
  | "approval_rejected"
  | "reviewer_failed"
  | "reviewer_timed_out"
  | "runtime_error";

export interface CodingWorkflowState {
  request: string;
  classification: CodingTaskClassification;
  output: string | null;
  evidence: WorkflowEvidence[];
  attempt: number;
  revisionInstructions: string[];
}

// 完成结果必须携带输出和证据；停止结果则排除 completed 状态及所有成功原因，防止非法组合。
export type CodingExecutorResult =
  | { type: "completed"; output: string; evidence: WorkflowEvidence[] }
  | {
      type: "stopped";
      status: Exclude<WorkflowStatus, "completed">;
      reason: Exclude<CodingStopReason,
        | "explanation_completed"
        | "related_files_identified"
        | "diagnosis_completed"
        | "implementation_plan_completed"
      >;
    };

export type CodingExecutor = (input: {
  request: string;
  classification: CodingTaskClassification;
  instructions: string;
  revisionInstructions: string[];
}) => Promise<CodingExecutorResult>;

// reviewer 只能读取本次 executor 完成后冻结的 trace 快照与当前摘要，并返回建议。
// 它不接收 WorkflowState 或 transition setter，保证最终路由仍由 coordinator 独占。
export type CodingReviewer = (input: {
  attempt: number;
  trace: readonly TraceEvent[];
  summary: string;
}) => Promise<ReviewerAgentRunResult>;

// 这是 coding mode 对上层暴露的稳定终态摘要，不泄漏内部 WorkflowState 的推进细节。
export interface CodingRunResult {
  status: WorkflowStatus;
  taskType: CodingTaskClassification["taskType"] | null;
  stopReason: CodingStopReason;
  completedSteps: number;
  finalOutput: string | null;
  tracePath: string;
}
