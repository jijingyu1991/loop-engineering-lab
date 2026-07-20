import type { StepError } from "../domain/stage-result.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
import { TraceInfrastructureError } from "../trace/trace-infrastructure-error.js";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
} from "./workflow-types.js";

function sanitizeError(error: unknown): StepError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

export async function runWorkflow<State>(options: {
  definition: WorkflowDefinition<State>;
  initialState: State;
  maxSteps: number;
  traceWriter: TraceWriter;
  now?: () => string;
}): Promise<WorkflowRunResult<State>> {
  const { definition, maxSteps, traceWriter } = options;
  const now = options.now ?? (() => new Date().toISOString());

  // 步数上限是 workflow 的安全边界，必须在产生任何 trace 前验证，避免留下一个
  // 看似已经启动、实际上配置无效的运行记录。
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError("maxSteps must be a positive integer");
  }

  let state = options.initialState;
  let currentStep = definition.initialStep;
  let completedSteps = 0;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const step = definition.steps.get(currentStep);
    if (!step) {
      await traceWriter.write({
        event: "workflow_step_failed",
        timestamp: now(),
        step: currentStep,
        stepIndex,
        error: sanitizeError(new Error(`Unknown workflow step: ${currentStep}`)),
      });

      return {
        state,
        status: "failed",
        stopReason: "workflow_step_failed",
        completedSteps,
      };
    }

    await traceWriter.write({
      event: "workflow_step_started",
      timestamp: now(),
      step: currentStep,
      stepIndex,
    });

    let result;
    try {
      result = await step.run(state);
    } catch (error) {
      // step.run 可以间接调用工具、reviewer 或子 workflow；这些层的 trace 写入也位于
      // 本 catch 范围内。RecordingTraceWriter 已在持久化边界标记此类故障，必须连同
      // 原始 cause 向上重抛，不能再写 workflow_step_failed 来伪装成普通业务失败。
      if (error instanceof TraceInfrastructureError) {
        throw error;
      }

      // 只有普通业务异常走稳定失败终态；该行为与既有 workflow 合同保持一致。
      await traceWriter.write({
        event: "workflow_step_failed",
        timestamp: now(),
        step: currentStep,
        stepIndex,
        error: sanitizeError(error),
      });

      return {
        state,
        status: "failed",
        stopReason: "workflow_step_failed",
        completedSteps,
      };
    }

    state = result.state;
    completedSteps += 1;

    await traceWriter.write({
      event: "workflow_step_completed",
      timestamp: now(),
      step: currentStep,
      stepIndex,
      evidence: result.evidence,
    });
    await traceWriter.write({
      event: "workflow_transition_decided",
      timestamp: now(),
      step: currentStep,
      stepIndex,
      transition: result.transition,
    });

    if (result.transition.type === "stop") {
      return {
        state,
        status: result.transition.status,
        stopReason: result.transition.reason,
        completedSteps,
      };
    }

    // 在进入下一轮前验证路由，保证失败 trace 仍归属于作出无效决策的当前 step。
    if (!definition.steps.has(result.transition.step)) {
      await traceWriter.write({
        event: "workflow_step_failed",
        timestamp: now(),
        step: currentStep,
        stepIndex,
        error: sanitizeError(
          new Error(`Unknown workflow step: ${result.transition.step}`),
        ),
      });

      return {
        state,
        status: "failed",
        stopReason: "workflow_step_failed",
        completedSteps,
      };
    }

    currentStep = result.transition.step;
  }

  return {
    state,
    status: "failed",
    stopReason: "max_workflow_steps_exceeded",
    completedSteps,
  };
}
