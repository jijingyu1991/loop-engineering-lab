/**
 * 每个阶段都使用相同的生命周期外壳。把状态、时间戳和数据放在一起，使 trace
 * writer 始终序列化同一种结构；泛型参数则保留各阶段 payload 的强类型信息。
 */
export interface StageResult<T> {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  source: "runtime" | "agent" | "skeleton";
  data: T | null;
  error: StepError | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** 已清理敏感细节、可以安全写入 trace 的错误表示。 */
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
