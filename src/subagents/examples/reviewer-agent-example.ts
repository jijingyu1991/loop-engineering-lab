import { z } from "zod";

import {
  workspaceRelativePathSchema,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const reviewerAgentExtensionsSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]),
    file: workspaceRelativePathSchema,
    line: z.number().int().positive(),
    title: z.string().min(1),
    rationale: z.string().min(1),
  }).strict()),
  reviewedFiles: z.array(workspaceRelativePathSchema).min(1),
}).strict();

export const reviewerAgentContract = {
  id: "review-workflow-runner",
  role: "reviewer-agent",
  task: "Review the supplied workflow runner diff for actionable defects.",
  scope: {
    include: ["src/runtime", "tests/unit"],
    exclude: [],
    constraints: ["Report evidence-backed findings; do not edit files."],
  },
  allowedTools: ["read", "search", "diff"],
  contextPackage: {
    items: [{
      id: "review-diff",
      kind: "git-diff",
      source: "git",
      content: "Review the current diff affecting src/runtime/run-workflow.ts.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return located findings or an explicit empty findings list."],
  },
  evidenceRequirements: {
    requiredKinds: ["review_scope"],
    minimumCount: 1,
  },
  limits: { timeoutMs: 15_000, maxSteps: 8 },
} satisfies SubagentContract;

export const reviewerAgentResult = {
  contractId: "review-workflow-runner",
  role: "reviewer-agent",
  status: "completed",
  summary: "Reviewed the scoped files and found no actionable defects.",
  evidence: [{
    kind: "review_scope",
    source: "review-diff",
    summary: "Reviewed run-workflow implementation and its unit tests.",
  }],
  errors: [],
  extensions: {
    findings: [],
    reviewedFiles: [
      "src/runtime/run-workflow.ts",
      "tests/unit/workflow-runner.test.ts",
    ],
  },
} satisfies SubagentResult;
