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
 * Convert the evidence gathered by earlier stages into one explicit decision.
 *
 * The order is intentional:
 * 1. Runtime failures always fail, even if skeleton verification says pass.
 * 2. A verified plan condition is business success.
 * 3. maxSteps is only a safety fallback when success was not demonstrated.
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
