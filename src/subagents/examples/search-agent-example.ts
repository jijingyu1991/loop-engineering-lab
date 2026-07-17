import { z } from "zod";

import {
  workspaceRelativePathSchema,
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const searchAgentExtensionsSchema = z.object({
  matches: z.array(z.object({
    path: workspaceRelativePathSchema,
    line: z.number().int().positive(),
    summary: z.string().min(1),
  }).strict()),
  searchedPaths: z.array(workspaceRelativePathSchema).min(1),
}).strict();

export const searchAgentContract = {
  id: "search-workflow-transition",
  role: "search-agent",
  task: "Find the definitions and consumers of WorkflowTransition.",
  scope: {
    include: ["src/runtime"],
    exclude: [],
    constraints: ["Read and search only; do not modify files."],
  },
  allowedTools: ["read", "search"],
  contextPackage: {
    items: [{
      id: "search-request",
      kind: "request",
      source: "user",
      content: "Locate WorkflowTransition and explain each match.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return matched files and explicit search evidence."],
  },
  evidenceRequirements: {
    requiredKinds: ["search_query", "search_match"],
    minimumCount: 2,
  },
  limits: { timeoutMs: 10_000, maxSteps: 6 },
} satisfies SubagentContract;

export const searchAgentResult = {
  contractId: "search-workflow-transition",
  role: "search-agent",
  status: "completed",
  summary: "Found the transition type and runner consumer.",
  evidence: [
    {
      kind: "search_query",
      source: "search",
      summary: "Searched src/runtime for WorkflowTransition.",
    },
    {
      kind: "search_match",
      source: "src/runtime/workflow-types.ts",
      summary: "Defines the WorkflowTransition discriminated union.",
    },
    {
      kind: "search_match",
      source: "src/runtime/run-workflow.ts",
      summary: "Consumes next and stop transitions.",
    },
  ],
  errors: [],
  extensions: {
    matches: [
      {
        path: "src/runtime/workflow-types.ts",
        line: 9,
        summary: "WorkflowTransition type definition.",
      },
      {
        path: "src/runtime/run-workflow.ts",
        line: 100,
        summary: "Workflow transition routing.",
      },
    ],
    searchedPaths: ["src/runtime"],
  },
} satisfies SubagentResult;
