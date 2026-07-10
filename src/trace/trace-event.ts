import type { LoopStage } from "../domain/loop-step.js";
import type { StepError } from "../domain/stage-result.js";
import type { StopReason } from "../domain/stop-decision.js";

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
  status: "completed" | "failed";
  stopReason: StopReason;
  completedSteps: number;
}

export type TraceEvent =
  | LoopStartedEvent
  | StageTraceEvent
  | LoopStoppedEvent;
