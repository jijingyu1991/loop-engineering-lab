import { MaxTurnsExceededError } from "@openai/agents";

import type {
  ActData,
  LoopStage,
  LoopStep,
  ObserveData,
  OrientData,
  PlanData,
  VerifyData,
} from "../domain/loop-step.js";
import { createPendingStage, type StageResult, type StepError } from "../domain/stage-result.js";
import type {
  StepDecision,
  StepOutcome,
  StepType,
} from "../domain/step-decision.js";
import type { StopDecision } from "../domain/stop-decision.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
import { resolveNextStep } from "./resolve-next-step.js";
import { runObserve } from "./stages/observe.js";
import { runOrient } from "./stages/orient.js";
import { runPlan } from "./stages/plan.js";
import { runReflect } from "./stages/reflect.js";
import { decideStop, type StopInput } from "./stages/stop.js";
import { runVerify } from "./stages/verify.js";

export interface ActExecutorInput {
  observation: ObserveData;
  plan: PlanData;
  maxTurns: number;
}

export type ActExecutor = (
  input: ActExecutorInput,
) => Promise<StepOutcome<ActData>>;

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

interface DecisionStageExecution<T> extends StageExecution<T> {
  decision: StepDecision | null;
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

/**
 * `StepDecision` 只控制本次运行时流转，不属于持久化的阶段业务数据。这个薄层
 * 在复用统一生命周期逻辑的同时把 outcome 拆开：data 继续写入 LoopStep 与
 * trace，decision 则只返回给协调器消费。
 */
async function executeDecisionStage<T>(input: {
  stepIndex: number;
  stageName: LoopStage;
  stage: StageResult<T>;
  traceWriter: TraceWriter;
  now: () => string;
  execute: () => Promise<StepOutcome<T>> | StepOutcome<T>;
}): Promise<DecisionStageExecution<T>> {
  let decision: StepDecision | null = null;
  const execution = await executeStage({
    ...input,
    execute: async () => {
      const outcome = await input.execute();
      decision = outcome.decision;
      return outcome.data;
    },
  });

  return { ...execution, decision };
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

async function skipPendingStage<T>(input: {
  stepIndex: number;
  stageName: LoopStage;
  stage: StageResult<T>;
  traceWriter: TraceWriter;
  now: () => string;
}): Promise<void> {
  if (input.stage.status === "pending") {
    await skipStage(input);
  }
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
 * 本函数只负责消费阶段返回的 `StepDecision`，不再拥有阶段顺序。switch 的职责
 * 是把阶段名称映射到具体实现并准备类型化输入；真正的下一阶段由执行结果决定。
 */
export async function runLoopStep(
  input: RunLoopStepInput,
): Promise<{ step: LoopStep; decision: StopDecision }> {
  const now = input.now ?? (() => new Date().toISOString());
  const step = createLoopStep(input.stepIndex, now());
  const visitedSteps = new Set<StepType>();
  let currentStep: StepType = "observe";
  let observation: ObserveData | null = null;
  let orientation: OrientData | null = null;
  let plan: PlanData | null = null;
  let action: ActData | null = null;
  let verification: VerifyData | null = null;
  let failureReason: StopInput["failureReason"];

  while (currentStep !== "stop") {
    visitedSteps.add(currentStep);
    let execution: DecisionStageExecution<unknown> | null = null;

    switch (currentStep) {
      case "observe": {
        const result = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "observe",
          stage: step.observe,
          traceWriter: input.traceWriter,
          now,
          execute: () =>
            runObserve({ task: input.task, previousStep: input.previousStep }),
        });
        observation = result.data;
        execution = result;
        break;
      }
      case "orient": {
        const completedObservation = observation;
        if (!completedObservation) {
          throw new Error("orient requires a completed observe stage");
        }
        const result = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "orient",
          stage: step.orient,
          traceWriter: input.traceWriter,
          now,
          execute: () => runOrient(completedObservation),
        });
        orientation = result.data;
        execution = result;
        break;
      }
      case "plan": {
        const completedOrientation = orientation;
        if (!completedOrientation) {
          throw new Error("plan requires a completed orient stage");
        }
        const result = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "plan",
          stage: step.plan,
          traceWriter: input.traceWriter,
          now,
          execute: () =>
            runPlan({
              stepIndex: step.index,
              objective: completedOrientation.objective,
            }),
        });
        plan = result.data;
        execution = result;
        break;
      }
      case "act": {
        const completedObservation = observation;
        const completedPlan = plan;
        if (!completedObservation || !completedPlan) {
          throw new Error("act requires completed observe and plan stages");
        }
        const result = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "act",
          stage: step.act,
          traceWriter: input.traceWriter,
          now,
          execute: () =>
            input.act({
              observation: completedObservation,
              plan: completedPlan,
              maxTurns: input.maxTurns,
            }),
        });
        action = result.data;
        execution = result;
        break;
      }
      case "verify": {
        const completedPlan = plan;
        const completedAction = action;
        if (!completedPlan || !completedAction) {
          throw new Error("verify requires completed plan and act stages");
        }
        const result = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "verify",
          stage: step.verify,
          traceWriter: input.traceWriter,
          now,
          execute: () =>
            runVerify({
              stepIndex: step.index,
              plan: completedPlan,
              actionOutput: completedAction.output,
            }),
        });
        verification = result.data;
        execution = result;
        break;
      }
      case "reflect": {
        const completedAction = action;
        const completedVerification = verification;
        if (!completedAction || !completedVerification) {
          throw new Error("reflect requires completed act and verify stages");
        }
        execution = await executeDecisionStage({
          stepIndex: step.index,
          stageName: "reflect",
          stage: step.reflect,
          traceWriter: input.traceWriter,
          now,
          execute: () =>
            runReflect({
              actionOutput: completedAction.output,
              verification: completedVerification,
            }),
        });
        break;
      }
    }

    // switch 对当前 StepType 应当穷尽；该检查同时防御未来扩展 StepType 时忘记
    // 注册执行器，使协议错误在本轮内立即显现。
    if (!execution) {
      throw new Error(`No executor registered for stage: ${currentStep}`);
    }

    if (!execution.ok || !execution.decision) {
      failureReason =
        execution.rawError instanceof MaxTurnsExceededError
          ? "max_turns_exceeded"
          : "step_error";
      currentStep = "stop";
      continue;
    }

    currentStep = resolveNextStep(execution.decision, visitedSteps);
  }

  // 条件跳转或失败都可能留下未执行槽位。按协议展示顺序依次标记 skipped，
  // 保证 trace 阅读者仍能区分“未选择执行”和“执行失败”。
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "observe",
    stage: step.observe,
    traceWriter: input.traceWriter,
    now,
  });
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "orient",
    stage: step.orient,
    traceWriter: input.traceWriter,
    now,
  });
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "plan",
    stage: step.plan,
    traceWriter: input.traceWriter,
    now,
  });
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "act",
    stage: step.act,
    traceWriter: input.traceWriter,
    now,
  });
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "verify",
    stage: step.verify,
    traceWriter: input.traceWriter,
    now,
  });
  await skipPendingStage({
    stepIndex: step.index,
    stageName: "reflect",
    stage: step.reflect,
    traceWriter: input.traceWriter,
    now,
  });

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
        verificationPassed: verification?.passed ?? false,
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
