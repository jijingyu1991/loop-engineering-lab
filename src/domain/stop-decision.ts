export type StopReason =
  | "max_turns_exceeded"
  | "step_error"
  | "plan_condition_met"
  | "max_steps_exceeded"
  | "tool_error"
  | "action_failed"
  | "user_action_required"
  | "action_cancelled"
  | "approval_required"
  | "approval_rejected";

/**
 * 使用可辨识联合类型，防止调用方在“loop 应继续”的决策上意外附加停止原因，
 * 从类型层面保证 `shouldStop`、状态和原因始终相互一致。
 */
export type StopDecision =
  | {
      shouldStop: false;
      status: "running";
      reason: null;
    }
  | {
      shouldStop: true;
      status: "completed" | "failed" | "blocked" | "cancelled";
      reason: StopReason;
    };
