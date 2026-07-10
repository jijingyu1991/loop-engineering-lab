import type { LoopStep } from "./loop-step.js";
import type { StopReason } from "./stop-decision.js";

/** The complete, traceable state owned by a single loop run. */
export interface LoopState {
  task: string;
  activeModel: string;
  status: "running" | "completed" | "failed";
  steps: LoopStep[];
  stopReason: StopReason | null;
  startedAt: string;
  stoppedAt: string | null;
}
