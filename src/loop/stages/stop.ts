import type {
  StopDecision,
  StopReason,
} from "../../domain/stop-decision.js";

export interface StopInput {
  stepIndex: number;
  maxSteps: number;
  verificationPassed: boolean;
  failureReason?: Extract<StopReason, "max_turns_exceeded" | "step_error">;
}

/**
 * 把前序阶段收集到的证据转换为一个明确的停止决策。
 *
 * 判断顺序是有意设计的：
 * 1. 运行时失败始终判为失败，即使骨架 verify 给出了通过结果。
 * 2. 已验证的 plan 条件表示业务成功。
 * 3. 只有尚未证明成功时，`maxSteps` 才作为防止失控的安全兜底。
 */
export function decideStop(input: StopInput): StopDecision {
  if (input.failureReason) {
    return {
      shouldStop: true,
      status: "failed",
      reason: input.failureReason,
    };
  }

  if (input.verificationPassed) {
    return {
      shouldStop: true,
      status: "completed",
      reason: "plan_condition_met",
    };
  }

  if (input.stepIndex >= input.maxSteps) {
    return {
      shouldStop: true,
      status: "failed",
      reason: "max_steps_exceeded",
    };
  }

  return {
    shouldStop: false,
    status: "running",
    reason: null,
  };
}
