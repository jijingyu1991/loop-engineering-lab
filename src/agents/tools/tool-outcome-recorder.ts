import type { ToolError } from "../../domain/tool-error.js";

export interface ToolOutcomeRecorder {
  checkpoint(): number;
  recordFailure(error: ToolError): void;
  failuresSince(checkpoint: number): ToolError[];
}

/**
 * recorder 是当前进程内的顺序事件视图。checkpoint 使用数组长度而不是时间戳，
 * 从而不受时钟精度影响，也能让连续 act 精确读取各自开始之后的失败。
 */
export function createToolOutcomeRecorder(): ToolOutcomeRecorder {
  const failures: ToolError[] = [];

  return {
    checkpoint: () => failures.length,
    recordFailure: (error) => failures.push(error),
    failuresSince: (checkpoint) => {
      if (
        !Number.isInteger(checkpoint) ||
        checkpoint < 0 ||
        checkpoint > failures.length
      ) {
        throw new RangeError("Invalid tool outcome checkpoint");
      }
      return failures.slice(checkpoint);
    },
  };
}
