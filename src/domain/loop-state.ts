import type { LoopStep } from "./loop-step.js";
import type { StopReason } from "./stop-decision.js";

export type LoopStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/** 一次 loop 运行独立拥有的完整、可追踪状态。 */
export interface LoopState {
  task: string;
  activeModel: string;
  status: LoopStatus;
  steps: LoopStep[];
  stopReason: StopReason | null;
  startedAt: string;
  stoppedAt: string | null;
}
