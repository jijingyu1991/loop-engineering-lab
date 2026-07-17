import { z } from "zod";

import {
  type SubagentContract,
  type SubagentResult,
} from "../../domain/subagent-contract.js";

export const testAgentExtensionsSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  failedTests: z.array(z.string().min(1)),
}).strict();

export const testAgentContract = {
  id: "test-workflow-runner",
  role: "test-agent",
  task: "Run the narrow workflow runner unit test and summarize its result.",
  scope: {
    include: ["tests/unit", "src/runtime"],
    exclude: [],
    constraints: ["Do not edit source or test files."],
  },
  allowedTools: ["read", "search", "test"],
  contextPackage: {
    items: [{
      id: "test-request",
      kind: "request",
      source: "user",
      content: "Check the workflow runner unit tests.",
    }],
    maxChars: 100,
  },
  expectedOutput: {
    format: "subagent-result",
    requirements: ["Return the exact command, exit code, and failed test names."],
  },
  evidenceRequirements: {
    requiredKinds: ["test_command", "test_result"],
    minimumCount: 2,
  },
  limits: { timeoutMs: 30_000, maxSteps: 8 },
} satisfies SubagentContract;

export const testAgentResult = {
  contractId: "test-workflow-runner",
  role: "test-agent",
  status: "completed",
  summary: "The workflow runner unit tests passed.",
  evidence: [
    {
      kind: "test_command",
      source: "test",
      summary: "Ran ./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts.",
    },
    {
      kind: "test_result",
      source: "test",
      summary: "Process exited with code 0 and reported no failed tests.",
    },
  ],
  errors: [],
  extensions: {
    command: "./node_modules/.bin/tsx --test tests/unit/workflow-runner.test.ts",
    exitCode: 0,
    failedTests: [],
  },
} satisfies SubagentResult;
