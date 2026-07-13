import type { LoopState } from "../domain/loop-state.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
import { createLoopState } from "./create-loop-state.js";
import {
  runLoopStep,
  type ActExecutor,
} from "./run-loop-step.js";

export interface RunLoopOptions {
  task: string;
  activeModel: string;
  maxSteps: number;
  maxTurns: number;
  traceWriter: TraceWriter;
  act: ActExecutor;
  now?: () => string;
}

/** 重复执行完整的 LoopStep，直到 stop 阶段返回终态决策。 */
export async function runLoop(options: RunLoopOptions): Promise<LoopState> {
  const now = options.now ?? (() => new Date().toISOString());
  const state = createLoopState(options.task, options.activeModel, now());

  await options.traceWriter.write({
    event: "loop_started",
    timestamp: state.startedAt,
    task: state.task,
    activeModel: state.activeModel,
  });

  while (state.status === "running") {
    const previousStep = state.steps.at(-1);
    const { step, decision } = await runLoopStep({
      task: state.task,
      stepIndex: state.steps.length + 1,
      previousStep,
      maxSteps: options.maxSteps,
      maxTurns: options.maxTurns,
      traceWriter: options.traceWriter,
      act: options.act,
      now,
    });

    state.steps.push(step);

    if (decision.shouldStop) {
      // 先把决策复制到持久状态，再写入最终事件，确保调用方和 trace 阅读者看到
      // 完全一致的终态事实，避免状态与审计记录出现短暂分歧。
      state.status = decision.status;
      state.stopReason = decision.reason;
      state.stoppedAt = now();

      await options.traceWriter.write({
        event: "loop_stopped",
        timestamp: state.stoppedAt,
        status: state.status,
        stopReason: state.stopReason,
        completedSteps: state.steps.length,
      });
    }
  }

  return state;
}
