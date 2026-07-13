import { MaxTurnsExceededError } from "@openai/agents";

import type {
  ActData,
  LoopStage,
  LoopStep,
  ObserveData,
  PlanData,
} from "../domain/loop-step.js";
import { createPendingStage, type StageResult, type StepError } from "../domain/stage-result.js";
import type { StopDecision } from "../domain/stop-decision.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
import { runObserve } from "./stages/observe.js";
import { runOrient } from "./stages/orient.js";
import { runPlan } from "./stages/plan.js";
import { runReflect } from "./stages/reflect.js";
import { decideStop } from "./stages/stop.js";
import { runVerify } from "./stages/verify.js";

export interface ActExecutorInput {
  observation: ObserveData;
  plan: PlanData;
  maxTurns: number;
}

export type ActExecutor = (input: ActExecutorInput) => Promise<ActData>;

export interface RunLoopStepInput {
  task: string;
  stepIndex: number;
  previousStep?: LoopStep;
  maxSteps: number;
  maxTurns: number;
  traceWriter: TraceWriter;
  act: ActExecutor;
  now?: () => string;
}

interface StageExecution<T> {
  ok: boolean;
  data: T | null;
  rawError?: unknown;
}

function sanitizeError(error: unknown): StepError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: "UnknownError", message: String(error) };
}

async function executeStage<T>(input: {
  stepIndex: number;
  stageName: LoopStage;
  stage: StageResult<T>;
  traceWriter: TraceWriter;
  now: () => string;
  execute: () => Promise<T> | T;
}): Promise<StageExecution<T>> {
  input.stage.status = "running";
  input.stage.startedAt = input.now();
  await input.traceWriter.write({
    event: "stage_started",
    timestamp: input.stage.startedAt,
    stepIndex: input.stepIndex,
    stage: input.stageName,
    source: input.stage.source,
  });

  try {
    const data = await input.execute();
    input.stage.status = "completed";
    input.stage.data = data;
    input.stage.completedAt = input.now();
    await input.traceWriter.write({
      event: "stage_completed",
      timestamp: input.stage.completedAt,
      stepIndex: input.stepIndex,
      stage: input.stageName,
      source: input.stage.source,
      data,
    });
    return { ok: true, data };
  } catch (error) {
    const safeError = sanitizeError(error);
    input.stage.status = "failed";
    input.stage.error = safeError;
    input.stage.completedAt = input.now();
    await input.traceWriter.write({
      event: "stage_failed",
      timestamp: input.stage.completedAt,
      stepIndex: input.stepIndex,
      stage: input.stageName,
      source: input.stage.source,
      error: safeError,
    });
    return { ok: false, data: null, rawError: error };
  }
}

async function skipStage<T>(input: {
  stepIndex: number;
  stageName: LoopStage;
  stage: StageResult<T>;
  traceWriter: TraceWriter;
  now: () => string;
}): Promise<void> {
  input.stage.status = "skipped";
  input.stage.completedAt = input.now();
  await input.traceWriter.write({
    event: "stage_skipped",
    timestamp: input.stage.completedAt,
    stepIndex: input.stepIndex,
    stage: input.stageName,
    source: input.stage.source,
  });
}

function createLoopStep(index: number, startedAt: string): LoopStep {
  return {
    index,
    status: "running",
    observe: createPendingStage("runtime"),
    orient: createPendingStage("skeleton"),
    plan: createPendingStage("skeleton"),
    act: createPendingStage("agent"),
    verify: createPendingStage("skeleton"),
    reflect: createPendingStage("skeleton"),
    stop: createPendingStage("runtime"),
    startedAt,
    completedAt: null,
  };
}

/**
 * 只运行一个完整的 LoopStep。
 *
 * 本函数是协议协调器：它负责阶段顺序，但把各阶段的业务含义委托给小函数。
 * 状态变更被有意集中在这里，方便学习者在一个位置追踪所有生命周期转换。
 */
export async function runLoopStep(
  input: RunLoopStepInput,
): Promise<{ step: LoopStep; decision: StopDecision }> {
  const now = input.now ?? (() => new Date().toISOString());
  const step = createLoopStep(input.stepIndex, now());

  const observation = await executeStage({
    stepIndex: step.index,
    stageName: "observe",
    stage: step.observe,
    traceWriter: input.traceWriter,
    now,
    execute: () =>
      runObserve({ task: input.task, previousStep: input.previousStep }),
  });

  const orientation = observation.data
    ? await executeStage({
        stepIndex: step.index,
        stageName: "orient",
        stage: step.orient,
        traceWriter: input.traceWriter,
        now,
        execute: () => runOrient(observation.data!),
      })
    : { ok: false, data: null };

  if (!observation.ok) {
    await skipStage({ stepIndex: step.index, stageName: "orient", stage: step.orient, traceWriter: input.traceWriter, now });
  }

  const plan = orientation.data
    ? await executeStage({
        stepIndex: step.index,
        stageName: "plan",
        stage: step.plan,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runPlan({ stepIndex: step.index, objective: orientation.data!.objective }),
      })
    : { ok: false, data: null };

  if (!orientation.ok) {
    await skipStage({ stepIndex: step.index, stageName: "plan", stage: step.plan, traceWriter: input.traceWriter, now });
  }

  const action = observation.data && plan.data
    ? await executeStage({
        stepIndex: step.index,
        stageName: "act",
        stage: step.act,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          input.act({
            observation: observation.data!,
            plan: plan.data!,
            maxTurns: input.maxTurns,
          }),
      })
    : { ok: false, data: null };

  if (!plan.ok) {
    await skipStage({ stepIndex: step.index, stageName: "act", stage: step.act, traceWriter: input.traceWriter, now });
  }

  const verification = plan.data && action.data
    ? await executeStage({
        stepIndex: step.index,
        stageName: "verify",
        stage: step.verify,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runVerify({
            stepIndex: step.index,
            plan: plan.data!,
            actionOutput: action.data!.output,
          }),
      })
    : { ok: false, data: null };

  if (!action.ok) {
    await skipStage({ stepIndex: step.index, stageName: "verify", stage: step.verify, traceWriter: input.traceWriter, now });
  }

  const reflection = action.data && verification.data
    ? await executeStage({
        stepIndex: step.index,
        stageName: "reflect",
        stage: step.reflect,
        traceWriter: input.traceWriter,
        now,
        execute: () =>
          runReflect({
            actionOutput: action.data!.output,
            verification: verification.data!,
          }),
      })
    : { ok: false, data: null };

  if (!verification.ok) {
    await skipStage({ stepIndex: step.index, stageName: "reflect", stage: step.reflect, traceWriter: input.traceWriter, now });
  }

  const failedExecution = [observation, orientation, plan, action, verification, reflection].find(
    (execution) => !execution.ok && execution.rawError !== undefined,
  );
  const failureReason =
    failedExecution?.rawError instanceof MaxTurnsExceededError
      ? "max_turns_exceeded"
      : failedExecution
        ? "step_error"
        : undefined;

  const stopExecution = await executeStage({
    stepIndex: step.index,
    stageName: "stop",
    stage: step.stop,
    traceWriter: input.traceWriter,
    now,
    execute: () =>
      decideStop({
        stepIndex: step.index,
        maxSteps: input.maxSteps,
        verificationPassed: verification.data?.passed ?? false,
        failureReason,
      }),
  });

  // `decideStop` 当前是纯函数，理论上不会失败。这里仍显式检查返回数据，确保
  // 未来 stop 实现变复杂时，阶段契约被破坏也能立即暴露，而不是继续传播空值。
  if (!stopExecution.data) {
    throw new Error("Stop stage did not produce a decision");
  }

  step.status =
    stopExecution.data.shouldStop && stopExecution.data.status === "failed"
      ? "failed"
      : "completed";
  step.completedAt = now();

  return { step, decision: stopExecution.data };
}
