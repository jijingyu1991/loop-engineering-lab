import { z } from "zod";

export const SUBAGENT_ROLES = [
  "search-agent",
  "test-agent",
  "reviewer-agent",
] as const;

export const SUBAGENT_TOOLS = ["read", "search", "test", "diff"] as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// extensions 会跨越 Agent/trace 边界，因此这里递归限制为真正可序列化的 JSON 值。
// finite() 进一步排除 JSON 无法保真表示的 Infinity 与 NaN。
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

// Contract 中的路径只能描述 workspace 内部资源。拒绝绝对路径、Windows 分隔符、
// 空路径段以及 . / ..，避免调用方借由 scope 表达越界访问。
function isWorkspaceRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || value.includes("//")) {
    return false;
  }

  const segments = value.split("/");
  return segments.length > 0 && segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export const workspaceRelativePathSchema = z.string().min(1).refine(
  isWorkspaceRelativePath,
  "Path must be a workspace-relative POSIX path without traversal",
);

const subagentContextItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  content: z.string(),
}).strict();

const subagentScopeSchema = z.object({
  include: z.array(workspaceRelativePathSchema).min(1),
  exclude: z.array(workspaceRelativePathSchema),
  constraints: z.array(z.string().min(1)),
}).strict();

const subagentExpectedOutputSchema = z.object({
  format: z.literal("subagent-result"),
  requirements: z.array(z.string().min(1)).min(1),
}).strict();

const subagentEvidenceRequirementsSchema = z.object({
  requiredKinds: z.array(z.string().min(1)).min(1),
  minimumCount: z.number().int().positive(),
}).strict();

export const subagentContractSchema = z.object({
  id: z.string().min(1),
  role: z.enum(SUBAGENT_ROLES),
  task: z.string().min(1),
  scope: subagentScopeSchema,
  allowedTools: z.array(z.enum(SUBAGENT_TOOLS)),
  contextPackage: z.object({
    items: z.array(subagentContextItemSchema),
    maxChars: z.number().int().positive(),
  }).strict(),
  expectedOutput: subagentExpectedOutputSchema,
  evidenceRequirements: subagentEvidenceRequirementsSchema,
  limits: z.object({
    timeoutMs: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((contract, context) => {
  // 单字段 schema 无法表达数组去重与内容总长度预算，因此在对象级校验中维护
  // 这两个跨字段不变量，并把错误路径定位到调用方可直接修复的位置。
  if (new Set(contract.allowedTools).size !== contract.allowedTools.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedTools"],
      message: "allowedTools must not contain duplicates",
    });
  }

  const contextChars = contract.contextPackage.items.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  if (contextChars > contract.contextPackage.maxChars) {
    context.addIssue({
      code: "custom",
      path: ["contextPackage", "items"],
      message: "Context package exceeds maxChars",
    });
  }
});

// 这里只复制 WorkflowEvidence 的稳定结构约定，不导入 runtime 类型模块，
// 以保持 domain contract 对具体执行器和 provider 的中立性。
const workflowEvidenceSchema = z.object({
  kind: z.string().min(1),
  source: z.string().min(1),
  summary: z.string().min(1),
}).strict();

const subagentErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export const subagentResultSchema = z.object({
  contractId: z.string().min(1),
  role: z.enum(SUBAGENT_ROLES),
  status: z.enum(["completed", "failed", "blocked", "timed_out"]),
  summary: z.string().min(1),
  evidence: z.array(workflowEvidenceSchema),
  errors: z.array(subagentErrorSchema),
  extensions: jsonObjectSchema.optional(),
}).strict();

export type SubagentRole = z.infer<typeof subagentContractSchema>["role"];
export type AllowedSubagentTool = z.infer<
  typeof subagentContractSchema
>["allowedTools"][number];
export type SubagentContextItem = z.infer<
  typeof subagentContractSchema
>["contextPackage"]["items"][number];
export type SubagentContract = z.infer<typeof subagentContractSchema>;
export type SubagentResult = z.infer<typeof subagentResultSchema>;
export type SubagentError = SubagentResult["errors"][number];
