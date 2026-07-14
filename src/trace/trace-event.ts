import type { LoopStage } from "../domain/loop-step.js";
import type { LoopStatus } from "../domain/loop-state.js";
import type { StepError } from "../domain/stage-result.js";
import type {
  ToolError,
  ToolEvidence,
} from "../agents/tools/tool-result.js";
import type { StopReason } from "../domain/stop-decision.js";

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

export type TraceEvent =
  | LoopStartedEvent
  | StageTraceEvent
  | LoopStoppedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolApprovalRequestedEvent
  | ToolApprovalResolvedEvent;
