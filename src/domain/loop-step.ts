import type { StageResult } from "./stage-result.js";
import type { StopDecision } from "./stop-decision.js";

export const LOOP_STAGE_ORDER = [
  "observe",
  "orient",
  "plan",
  "act",
  "verify",
  "reflect",
  "stop",
] as const;

export type LoopStage = (typeof LOOP_STAGE_ORDER)[number];

export interface ObserveData {
  task: string;
  previousAction: string | null;
  previousReflection: string | null;
}

export interface OrientData {
  objective: string;
  constraints: string[];
}

export interface PlanData {
  nextAction: string;
  stopCondition: {
    description: string;
  };
}

export interface ActData {
  output: string;
}

export interface VerifyData {
  passed: boolean;
  evidence: string;
}

export interface ReflectData {
  summary: string;
  nextFocus: string | null;
}

/**
 * One LoopStep is one full OODA-inspired iteration, not one model request.
 * Today only `act` calls a model, but the typed slots let future planner or
 * reviewer Agents replace skeleton stages without changing the outer runner.
 */
export interface LoopStep {
  index: number;
  status: "running" | "completed" | "failed";
  observe: StageResult<ObserveData>;
  orient: StageResult<OrientData>;
  plan: StageResult<PlanData>;
  act: StageResult<ActData>;
  verify: StageResult<VerifyData>;
  reflect: StageResult<ReflectData>;
  stop: StageResult<StopDecision>;
  startedAt: string;
  completedAt: string | null;
}
