import type { LoopStage } from "./loop-step.js";

/** 当前可被阶段决策选择的执行节点；stop 是唯一终态节点。 */
export type StepType = LoopStage;

/**
 * 非终态阶段显式声明下一执行节点及机器可读原因。reason 暂时保持 string，
 * 等协议稳定后再收窄为字面量联合，避免过早固化不完整的原因集合。
 */
export interface StepDecision {
  nextStep: StepType;
  reason: string;
}

/** 阶段业务数据和控制流决策同时产生，但只有 data 会进入持久化 LoopStep。 */
export interface StepOutcome<T> {
  data: T;
  decision: StepDecision;
}
