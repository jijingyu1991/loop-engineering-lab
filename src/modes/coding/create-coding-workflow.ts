import type {
  WorkflowDefinition,
  WorkflowEvidence,
} from "../../runtime/workflow-types.js";
import type {
  CodingExecutor,
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
}): WorkflowDefinition<CodingWorkflowState> {
  const prompt = WORKFLOW_PROMPTS[input.taskType];

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

          return {
            state: {
              ...state,
              // disclosure 是 workflow 的运行时后置条件，不能只寄希望于模型遵循
              // prompt。已有精确句子的输出保持逐字不变，缺失时才确定性补齐。
              output,
              evidence: [...state.evidence, ...executorResult.evidence],
            },
            evidence: executorResult.evidence,
            transition: {
              type: "stop" as const,
              status: "completed" as const,
              reason: prompt.stopReason,
            },
          };
        },
      }],
    ]),
  };
}
