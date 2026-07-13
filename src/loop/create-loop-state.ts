import type { LoopState } from "../domain/loop-state.js";

/**
 * 通过接收外部时间戳，让状态创建保持确定性：测试可以断言精确值，生产环境则
 * 传入真实的 ISO 时间戳。
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
