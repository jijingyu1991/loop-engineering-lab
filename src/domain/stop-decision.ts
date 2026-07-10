export type StopReason =
  | "max_turns_exceeded"
  | "step_error"
  | "plan_condition_met"
  | "max_steps_exceeded";

/**
 * A discriminated union prevents callers from accidentally attaching a stop
 * reason to a decision that says the loop should continue.
 */
export type StopDecision =
  | {
      shouldStop: false;
      status: "running";
      reason: null;
    }
  | {
      shouldStop: true;
      status: "completed" | "failed";
      reason: StopReason;
    };
