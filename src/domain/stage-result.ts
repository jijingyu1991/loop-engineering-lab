/**
 * Every stage uses the same lifecycle envelope. Keeping status, timestamps and
 * data together gives the trace writer one uniform shape to serialize, while
 * the generic parameter preserves the strongly typed payload of each stage.
 */
export interface StageResult<T> {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  source: "runtime" | "agent" | "skeleton";
  data: T | null;
  error: StepError | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** A sanitized error representation that is safe to write to the trace. */
export interface StepError {
  name: string;
  message: string;
}

export function createPendingStage<T>(
  source: StageResult<T>["source"],
): StageResult<T> {
  return {
    status: "pending",
    source,
    data: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}
