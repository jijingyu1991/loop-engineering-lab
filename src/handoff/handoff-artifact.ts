import type { CodingStopReason } from "../modes/coding/coding-state.js";
import type { CodingTaskType } from "../modes/coding/coding-task.js";
import type { WorkflowStatus } from "../runtime/workflow-types.js";

// 所有限制都集中在领域合同旁边，builder 与 renderer 不会各自发明不同预算。
// 这些值限制的是交接摘要，而不是 JSONL trace；完整审计信息仍保留在 trace 中。
export const HANDOFF_LIMITS = {
  goalChars: 2_000,
  finalOutputChars: 2_000,
  completedSteps: 10,
  openQuestions: 5,
  evidence: 10,
  evidenceChars: 300,
  failedAttempts: 5,
  failedAttemptChars: 300,
  nextActionChars: 500,
} as const;

export interface HandoffCompletedStep {
  step: string;
  evidence: string[];
}

export interface HandoffEvidence {
  kind: string;
  source: string;
  summary: string;
}

export interface HandoffFailedAttempt {
  kind: string;
  summary: string;
  suggestedNextStep: string | null;
}

export interface HandoffArtifact {
  goal: string;
  currentState: {
    status: WorkflowStatus;
    taskType: CodingTaskType | null;
    stopReason: CodingStopReason;
    completedSteps: number;
    finalOutput: string | null;
    tracePath: string;
  };
  completedSteps: HandoffCompletedStep[];
  openQuestions: string[];
  evidence: HandoffEvidence[];
  failedAttempts: HandoffFailedAttempt[];
  nextRecommendedAction: string;
}
