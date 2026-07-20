import {
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";
import { reviewerAgentExtensionsSchema } from "../reviewer/reviewer-contract.js";

// 示例继续从原模块导出 schema，避免已有消费者因协议实现移到 reviewer 目录而改变导入路径。
export { reviewerAgentExtensionsSchema } from "../reviewer/reviewer-contract.js";

export const reviewerAgentContract = {
  id: "review-coding-attempt-1",
  role: "reviewer-agent",
  task: "Review the executor summary against the supplied trace.",
  scope: {
    include: ["traces"],
    exclude: [],
    constraints: ["Use only context items; do not execute tools or modify files."],
  },
  allowedTools: [],
  contextPackage: {
    items: [
      {
        id: "coding-trace",
        kind: "trace",
        source: "runtime",
        content: "[{\"event\":\"coding_run_started\",\"timestamp\":\"2026-07-20T00:00:00.000Z\"}]",
      },
      {
        id: "executor-summary",
        kind: "summary",
        source: "executor",
        content: "Executor completed the requested coding task.",
      },
    ],
    maxChars: 100_000,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return pass, revise, or ask_user with three trace-backed checks."],
  },
  evidenceRequirements: {
    requiredKinds: ["review_decision", "trace_reference"],
    minimumCount: 2,
  },
  limits: { timeoutMs: 15_000, maxSteps: 8 },
} satisfies SubagentContract;

export const reviewerAgentResult = {
  contractId: "review-coding-attempt-1",
  role: "reviewer-agent",
  status: "completed",
  summary: "The executor summary passes review.",
  evidence: [
    {
      kind: "review_decision",
      source: "review-coding-attempt-1",
      summary: "pass",
    },
    {
      kind: "trace_reference",
      source: "coding-trace",
      summary: "All checks reference trace index 0.",
    },
  ],
  errors: [],
  extensions: {
    decision: "pass",
    checks: [
      {
        criterion: "conclusion_evidence",
        status: "passed",
        summary: "Claims cite trace.",
        traceReferences: [0],
      },
      {
        criterion: "failure_disclosure",
        status: "passed",
        summary: "No failure was omitted.",
        traceReferences: [0],
      },
      {
        criterion: "required_validation",
        status: "passed",
        summary: "Required validation is present.",
        traceReferences: [0],
      },
    ],
    revisionInstructions: [],
  },
} satisfies SubagentResult;
