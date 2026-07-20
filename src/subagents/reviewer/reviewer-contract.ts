import { z } from "zod";

import {
  subagentContractSchema,
  validateSubagentResult,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";
import type { TraceEvent } from "../../trace/trace-event.js";

export const REVIEW_CRITERIA = [
  "conclusion_evidence",
  "failure_disclosure",
  "required_validation",
] as const;

const reviewerCheckSchema = z.object({
  criterion: z.enum(REVIEW_CRITERIA),
  status: z.enum(["passed", "failed", "needs_user"]),
  summary: z.string().min(1),
  traceReferences: z.array(z.number().int().nonnegative()).min(1),
}).strict();

// reviewer 只提供可审计的判断建议，不能携带 WorkflowTransition、总体状态或停止原因。
// 路由属于 coordinator 的职责；把该边界固化为严格 schema 可避免模型输出越权控制字段。
export const reviewerAgentExtensionsSchema = z.object({
  decision: z.enum(["pass", "revise", "ask_user"]),
  checks: z.array(reviewerCheckSchema).length(REVIEW_CRITERIA.length),
  revisionInstructions: z.array(z.string().min(1)),
  userQuestion: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  // 三项标准必须各出现一次，既防止同一维度重复造成遗漏，也使 coordinator 能按固定
  // 次序消费完整的审查覆盖面，而不依赖 Agent 的自然语言描述。
  const criteria = value.checks.map((check) => check.criterion);
  for (const criterion of REVIEW_CRITERIA) {
    if (criteria.filter((item) => item === criterion).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: `criterion must appear exactly once: ${criterion}`,
      });
    }
  }

  // 每个 decision 的附属字段存在明确的互斥关系。这里在解析边界拒绝矛盾建议，
  // 使后续 coordinator 不必猜测应优先修订、追问还是放行。
  if (value.decision === "pass") {
    if (value.checks.some((check) => check.status !== "passed")) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "pass requires every check to pass",
      });
    }
    if (value.revisionInstructions.length > 0 || value.userQuestion !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "pass cannot request revision or user input",
      });
    }
  }

  if (value.decision === "revise") {
    if (!value.checks.some((check) => check.status === "failed") || value.revisionInstructions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "revise requires a failed check and instructions",
      });
    }
    if (value.userQuestion !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["userQuestion"],
        message: "revise cannot ask the user",
      });
    }
  }

  if (value.decision === "ask_user") {
    if (!value.checks.some((check) => check.status === "needs_user") || value.userQuestion === undefined) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "ask_user requires a needs_user check and question",
      });
    }
    if (value.revisionInstructions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["revisionInstructions"],
        message: "ask_user cannot also request executor revision",
      });
    }
  }
});

export type ReviewerAgentExtensions = z.infer<typeof reviewerAgentExtensionsSchema>;
export type ReviewerAgentCompletedResult = Omit<SubagentResult, "status" | "extensions"> & {
  status: "completed";
  extensions: ReviewerAgentExtensions;
};
export type ReviewerAgentUnsuccessfulResult = Omit<SubagentResult, "status"> & {
  status: "failed" | "blocked" | "timed_out";
};
export type ReviewerAgentRunResult =
  | ReviewerAgentCompletedResult
  | ReviewerAgentUnsuccessfulResult;

export function createReviewerAgentContract(input: {
  attempt: number;
  trace: readonly TraceEvent[];
  summary: string;
  maxChars?: number;
  timeoutMs?: number;
  maxSteps?: number;
}): SubagentContract {
  // trace 快照和 executor summary 是 reviewer 唯二的事实来源。直接序列化完整快照，
  // 再交由统一 Contract 的 maxChars 校验拒绝超限，绝不悄悄截断而破坏引用的可验证性。
  const contextPackage = {
    items: [
      {
        id: "coding-trace",
        kind: "trace",
        source: "runtime",
        content: JSON.stringify(input.trace),
      },
      {
        id: "executor-summary",
        kind: "summary",
        source: "executor",
        content: input.summary,
      },
    ],
    maxChars: input.maxChars ?? 100_000,
  };

  return subagentContractSchema.parse({
    id: `review-coding-attempt-${input.attempt}`,
    role: "reviewer-agent",
    task: "Review the executor summary against the supplied trace.",
    scope: {
      include: ["traces"],
      exclude: [],
      constraints: ["Use only context items; do not execute tools or modify files."],
    },
    allowedTools: [],
    contextPackage,
    expectedOutput: {
      format: "subagent-result",
      requirements: ["Return pass, revise, or ask_user with three trace-backed checks."],
    },
    evidenceRequirements: {
      requiredKinds: ["review_decision", "trace_reference"],
      minimumCount: 2,
    },
    limits: { timeoutMs: input.timeoutMs ?? 15_000, maxSteps: input.maxSteps ?? 8 },
  });
}

export function validateReviewerAgentCompletedResult(
  contract: SubagentContract,
  result: unknown,
  traceLength: number,
): ReviewerAgentCompletedResult {
  // 先复用 provider-neutral 的通用身份、状态和证据验证，再处理 reviewer 专属协议。
  // 这样角色扩展不会绕过 Contract 的通用安全边界，也不会把角色知识反向渗入 domain。
  const validated = validateSubagentResult(contract, result);
  if (validated.status !== "completed") {
    throw new Error("Reviewer result is not completed");
  }

  const extensions = reviewerAgentExtensionsSchema.parse(validated.extensions);
  for (const check of extensions.checks) {
    // trace 索引必须指向创建 Contract 时冻结的快照。越界引用通常意味着模型看到了
    // 不在授权上下文内的新信息，因此直接失败，而不是截断或忽略该引用。
    if (check.traceReferences.some((reference) => reference >= traceLength)) {
      throw new Error("Reviewer trace reference is outside the frozen snapshot");
    }
  }
  return { ...validated, status: "completed", extensions };
}
