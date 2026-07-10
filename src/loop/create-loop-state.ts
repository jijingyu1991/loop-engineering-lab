import type { LoopState } from "../domain/loop-state.js";

/**
 * State creation is kept deterministic by receiving the timestamp. Tests can
 * assert exact values, while production passes a real ISO timestamp.
 */
export function createLoopState(
  task: string,
  activeModel: string,
  startedAt: string = new Date().toISOString(),
): LoopState {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new Error("Task must not be empty");
  }

  return {
    task: normalizedTask,
    activeModel,
    status: "running",
    steps: [],
    stopReason: null,
    startedAt,
    stoppedAt: null,
  };
}
