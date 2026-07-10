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

/** Repeat complete LoopSteps until the stop stage returns a terminal decision. */
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
      // Copy the decision into durable state before writing the final event so
      // callers and trace readers observe the same terminal facts.
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
