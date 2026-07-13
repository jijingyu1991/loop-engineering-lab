import type { LoopStep } from "./loop-step.js";
import type { StopReason } from "./stop-decision.js";

/** 一次 loop 运行独立拥有的完整、可追踪状态。 */
export interface LoopState {
  task: string;
  activeModel: string;
  status: "running" | "completed" | "failed";
  steps: LoopStep[];
  stopReason: StopReason | null;
  startedAt: string;
  stoppedAt: string | null;
}
