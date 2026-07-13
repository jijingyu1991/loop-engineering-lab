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
 * 一个 `LoopStep` 表示一次完整的、受 OODA 启发的迭代，而不是一次模型请求。
 * 当前只有 `act` 会调用模型，但这些类型化阶段槽位允许未来用 planner 或
 * reviewer Agent 替换骨架阶段，而不必修改外层 runner。
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
