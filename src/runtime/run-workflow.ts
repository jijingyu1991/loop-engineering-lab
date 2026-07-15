import type { StepError } from "../domain/stage-result.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
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
      // 捕获范围只包含业务 step；trace 写入故障不能被伪装成普通 workflow 失败，
      // 必须原样 reject，让调用方知道审计链已经不完整。
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
