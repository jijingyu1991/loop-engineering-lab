import type { LoopStage } from "../domain/loop-step.js";
import type { LoopStatus } from "../domain/loop-state.js";
import type { StepError } from "../domain/stage-result.js";
import type {
  AllowedSubagentTool,
  SubagentResult,
  SubagentRole,
} from "../domain/subagent-contract.js";
import type {
  ToolError,
  ToolEvidence,
} from "../agents/tools/tool-result.js";
import type { StopReason } from "../domain/stop-decision.js";
import type {
  WorkflowEvidence,
  WorkflowStatus,
  WorkflowTransition,
} from "../runtime/workflow-types.js";
import type { CodingStopReason } from "../modes/coding/coding-state.js";
import type {
  CodingTaskClassification,
  CodingTaskType,
} from "../modes/coding/coding-task.js";

export type LocalToolName = "file" | "search" | "shell";

export interface LoopStartedEvent {
  event: "loop_started";
  timestamp: string;
  task: string;
  activeModel: string;
}

export interface StageTraceEvent {
  event:
    | "stage_started"
    | "stage_completed"
    | "stage_failed"
    | "stage_skipped";
  timestamp: string;
  stepIndex: number;
  stage: LoopStage;
  source: "runtime" | "agent" | "skeleton";
  data?: unknown;
  error?: StepError;
}

export interface LoopStoppedEvent {
  event: "loop_stopped";
  timestamp: string;
  status: Exclude<LoopStatus, "running">;
  stopReason: StopReason;
  completedSteps: number;
}

export interface ToolStartedEvent {
  event: "tool_started";
  timestamp: string;
  tool: LocalToolName;
  operation: string;
  input: ToolEvidence;
}

export interface ToolCompletedEvent {
  event: "tool_completed";
  timestamp: string;
  tool: LocalToolName;
  operation: string;
  durationMs: number;
  evidence: ToolEvidence;
}

export interface ToolFailedEvent {
  event: "tool_failed";
  timestamp: string;
  tool: LocalToolName;
  operation: string;
  durationMs: number;
  error: ToolError;
}

export interface ToolApprovalRequestedEvent {
  event: "tool_approval_requested";
  timestamp: string;
  tool: "shell";
  toolCallId: string;
  input: ToolEvidence;
}

export interface ToolApprovalResolvedEvent {
  event: "tool_approval_resolved";
  timestamp: string;
  tool: "shell";
  toolCallId: string;
  approved: boolean;
  decision: "approved" | "rejected" | "unavailable";
}

export interface WorkflowStepStartedEvent {
  event: "workflow_step_started";
  timestamp: string;
  step: string;
  stepIndex: number;
}

export interface WorkflowStepCompletedEvent {
  event: "workflow_step_completed";
  timestamp: string;
  step: string;
  stepIndex: number;
  evidence: WorkflowEvidence[];
}

export interface WorkflowStepFailedEvent {
  event: "workflow_step_failed";
  timestamp: string;
  step: string;
  stepIndex: number;
  error: StepError;
}

export interface WorkflowTransitionDecidedEvent {
  event: "workflow_transition_decided";
  timestamp: string;
  step: string;
  stepIndex: number;
  transition: WorkflowTransition;
}

export interface CodingRunStartedEvent {
  event: "coding_run_started";
  timestamp: string;
  request: string;
  mode: "coding";
  activeModel: string;
}

export interface CodingTaskClassifiedEvent {
  event: "coding_task_classified";
  timestamp: string;
  classification: CodingTaskClassification;
}

export interface CodingExecutionCompletedEvent {
  event: "coding_execution_completed";
  timestamp: string;
  attempt: number;
  summary: string;
  evidence: WorkflowEvidence[];
}

export interface SubagentStartedEvent {
  event: "subagent_started";
  timestamp: string;
  contractId: string;
  role: SubagentRole;
  contextItemIds: string[];
  allowedTools: AllowedSubagentTool[];
  limits: { timeoutMs: number; maxSteps: number };
}

export interface SubagentFinishedEvent {
  event: "subagent_finished";
  timestamp: string;
  result: SubagentResult;
}

export type ContextCompactionFailureReason =
  | "invalid_tool_history"
  | "pinned_evidence_mismatch"
  | "pinned_content_exceeds_budget";

/**
 * 仅当输入确实超过预算、即将开始压缩时才写入。这里记录压缩前的稳定统计值，
 * 让 trace 能解释为什么发生压缩，同时避免复制可能很大的原始模型输入。
 */
export interface ContextCompactionStartedEvent {
  event: "context_compaction_started";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  inputItems: number;
  logicalGroups: number;
}

/**
 * 完成事件只保留可审计的计数、固定 evidence 标识和已清洗摘要元数据。完整工具
 * 内容继续由既有 tool trace 负责，防止 compaction trace 再次突破输入预算。
 */
export interface ContextCompactionCompletedEvent {
  event: "context_compaction_completed";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  afterChars: number;
  retainedGroups: number;
  summarizedToolResults: number;
  pinnedEvidenceIds: string[];
  summaries: Array<{
    callId: string;
    status: "succeeded" | "failed";
    summaryChars: number;
  }>;
}

/**
 * 失败原因限定为算法可预期且能安全分类的边界；基础设施写入失败由调用方继续
 * 以 TraceInfrastructureError 处理，不能被误记成普通 compaction 失败。
 */
export interface ContextCompactionFailedEvent {
  event: "context_compaction_failed";
  timestamp: string;
  budgetChars: number;
  beforeChars: number;
  reason: ContextCompactionFailureReason;
}

export interface CodingRunStoppedEvent {
  event: "coding_run_stopped";
  timestamp: string;
  status: WorkflowStatus;
  taskType: CodingTaskType | null;
  stopReason: CodingStopReason;
  completedSteps: number;
}

export type TraceEvent =
  | LoopStartedEvent
  | StageTraceEvent
  | LoopStoppedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolApprovalRequestedEvent
  | ToolApprovalResolvedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepCompletedEvent
  | WorkflowStepFailedEvent
  | WorkflowTransitionDecidedEvent
  | CodingRunStartedEvent
  | CodingTaskClassifiedEvent
  | CodingExecutionCompletedEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | ContextCompactionStartedEvent
  | ContextCompactionCompletedEvent
  | ContextCompactionFailedEvent
  | CodingRunStoppedEvent;
