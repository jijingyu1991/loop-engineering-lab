export type WorkflowStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface WorkflowEvidence {
  kind: string;
  source: string;
  summary: string;
}

export type WorkflowTransition =
  | { type: "next"; step: string; reason: string }
  | { type: "stop"; status: WorkflowStatus; reason: string };

export interface WorkflowStepResult<State> {
  state: State;
  evidence: WorkflowEvidence[];
  transition: WorkflowTransition;
}

export interface WorkflowStep<State> {
  name: string;
  run(state: State): Promise<WorkflowStepResult<State>>;
}

export interface WorkflowDefinition<State> {
  initialStep: string;
  steps: ReadonlyMap<string, WorkflowStep<State>>;
}

export interface WorkflowRunResult<State> {
  state: State;
  status: WorkflowStatus;
  stopReason: string;
  completedSteps: number;
}
