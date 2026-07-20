import type {
  WorkflowDefinition,
  WorkflowEvidence,
} from "../../runtime/workflow-types.js";
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import type { TraceEvent } from "../../trace/trace-event.js";
import type {
  CodingExecutor,
  CodingReviewer,
  CodingStopReason,
  CodingWorkflowState,
} from "./coding-state.js";
import type { CodingTaskType } from "./coding-task.js";

interface WorkflowPrompt {
  stopReason: CodingStopReason;
  instructions: string;
}

// Record 强制每一种分类都拥有专属成功原因和提示词；未来新增 CodingTaskType 时，
// TypeScript 会在这里报错，避免分类器能路由到一个没有执行语义的 workflow。
const WORKFLOW_PROMPTS: Record<CodingTaskType, WorkflowPrompt> = {
  explain_module: {
    stopReason: "explanation_completed",
    instructions: [
      "Explain the module using repository evidence.",
      "Cover responsibilities, entry points, dependencies, data flow, and failure boundaries.",
    ].join(" "),
  },
  find_related_files: {
    stopReason: "related_files_identified",
    instructions: [
      "Identify related repository files using grouped paths and relationship reasons.",
      "Return an explicit empty result when no files match.",
    ].join(" "),
  },
  diagnose_test_failure: {
    stopReason: "diagnosis_completed",
    instructions: [
      "Diagnose the failure with the narrowest configured test command and record exit evidence.",
      "Inspect the failing test and its implementation, then state a root-cause hypothesis, confidence, and next action.",
      "This workflow must forbid edits.",
    ].join(" "),
  },
  propose_implementation_plan: {
    stopReason: "implementation_plan_completed",
    instructions: [
      "Propose an implementation plan grounded in repository conventions.",
      "Include likely files, ordered steps, tests, and risks.",
      "End with the exact sentence: No files were modified.",
    ].join(" "),
  },
};

export function createCodingWorkflow(input: {
  taskType: CodingTaskType;
  executor: CodingExecutor;
  reviewer: CodingReviewer;
  traceWriter: TraceWriter;
  traceSnapshot: () => readonly TraceEvent[];
  now?: () => string;
}): WorkflowDefinition<CodingWorkflowState> {
  const prompt = WORKFLOW_PROMPTS[input.taskType];
  const now = input.now ?? (() => new Date().toISOString());

  return {
    initialStep: "understand_request",
    steps: new Map([
      ["understand_request", {
        name: "understand_request",
        run: async (state) => {
          // 这里把分类器的归一化目标和判定依据固化进 workflow evidence，后续即使
          // executor 被替换，trace 仍能回答“为何选择该路径、实际要解决什么”。
          const classificationEvidence: WorkflowEvidence[] = [
            {
              kind: "classification_objective",
              source: state.classification.taskType,
              summary: state.classification.objective,
            },
            {
              kind: "classification_reason",
              source: state.classification.taskType,
              summary: state.classification.reason,
            },
          ];

          return {
            state: {
              ...state,
              evidence: [...state.evidence, ...classificationEvidence],
            },
            evidence: classificationEvidence,
            transition: {
              type: "next" as const,
              step: "inspect_and_explain",
              reason: "request_understood",
            },
          };
        },
      }],
      ["inspect_and_explain", {
        name: "inspect_and_explain",
        run: async (state) => {
          const executorResult = await input.executor({
            request: state.request,
            classification: state.classification,
            instructions: prompt.instructions,
            revisionInstructions: state.revisionInstructions,
          });

          if (executorResult.type === "stopped") {
            return {
              state,
              evidence: [],
              transition: {
                type: "stop" as const,
                status: executorResult.status,
                reason: executorResult.reason,
              },
            };
          }

          const output = input.taskType === "propose_implementation_plan" &&
              !executorResult.output.includes("No files were modified.")
            ? `${executorResult.output}\n\nNo files were modified.`
            : executorResult.output;

          const attempt = state.attempt + 1;
          // reviewer 的判断必须能引用“当前摘要已经执行完成”的审计事实。先等待 trace
          // 持久化，再获取调用方提供的副本，避免 reviewer 观察到写入前或持续变化的数组。
          await input.traceWriter.write({
            event: "coding_execution_completed",
            timestamp: now(),
            attempt,
            summary: output,
            evidence: executorResult.evidence,
          });
          const trace = input.traceSnapshot();
          const reviewResult = await input.reviewer({
            attempt,
            trace,
            summary: output,
          });

          if (reviewResult.status !== "completed") {
            return {
              state: {
                ...state,
                attempt,
                output: null,
                evidence: [...state.evidence, ...reviewResult.evidence],
                revisionInstructions: [],
              },
              evidence: reviewResult.evidence,
              transition: {
                type: "stop" as const,
                status: "failed" as const,
                reason: reviewResult.status === "timed_out"
                  ? "reviewer_timed_out"
                  : "reviewer_failed",
              },
            };
          }

          // completed reviewer result 已在 reviewer adapter 边界按严格 schema 验证；
          // workflow 只消费建议字段，自身负责把建议映射为受控 transition。
          const extensions = reviewResult.extensions;
          if (extensions.decision === "pass") {
            return {
              state: {
                ...state,
                attempt,
                output,
                evidence: [
                  ...state.evidence,
                  ...executorResult.evidence,
                  ...reviewResult.evidence,
                ],
                revisionInstructions: [],
              },
              evidence: [...executorResult.evidence, ...reviewResult.evidence],
              transition: {
                type: "stop" as const,
                status: "completed" as const,
                reason: prompt.stopReason,
              },
            };
          }

          if (extensions.decision === "ask_user") {
            return {
              state: {
                ...state,
                attempt,
                output: extensions.userQuestion ?? null,
                evidence: [...state.evidence, ...reviewResult.evidence],
                revisionInstructions: [],
              },
              evidence: reviewResult.evidence,
              transition: {
                type: "stop" as const,
                status: "blocked" as const,
                reason: "user_action_required",
              },
            };
          }

          return {
            state: {
              ...state,
              attempt,
              // revise 时不保存未通过审查的摘要及其 executor evidence；该次执行已经
              // 写入 coding_execution_completed，可审计但不会被误当作成功终态输出。
              output: null,
              evidence: [...state.evidence, ...reviewResult.evidence],
              revisionInstructions: extensions.revisionInstructions,
            },
            evidence: reviewResult.evidence,
            transition: {
              type: "next" as const,
              step: "inspect_and_explain",
              reason: "review_revision_required",
            },
          };
        },
      }],
    ]),
  };
}
