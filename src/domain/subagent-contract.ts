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

// scope 的授权判断刻意采用 workspace 相对路径上的词法比较，不访问文件系统，
// 因而不存在因文件尚未生成而无法校验的问题。只接受 scope 本身或以 "/" 为边界的
// 子路径，避免把 src/runtime-other 这类公共前缀误判成 src/runtime 的后代；末尾斜杠
// 的归一化则让调用方即使绕过上游路径 schema，也不会改变同一路径的比较语义。
function isSameOrChildPath(candidate: string, scopePath: string): boolean {
  const normalizedScope = scopePath.endsWith("/")
    ? scopePath.slice(0, -1)
    : scopePath;
  return candidate === normalizedScope || candidate.startsWith(`${normalizedScope}/`);
}

function isEvidenceSourceAllowed(
  contract: SubagentContract,
  source: string,
): boolean {
  // evidence source 有两种不同语义：Contract、tool、context item 使用逻辑标识符，
  // 文件证据才使用 workspace 路径。逻辑来源必须显式出现在 Contract 的能力或上下文中；
  // 未命中逻辑白名单的值不能直接进入 scope 比较，必须先通过安全相对路径校验。
  const logicalSources = new Set([
    contract.id,
    ...contract.allowedTools,
    ...contract.contextPackage.items.map((item) => item.id),
  ]);
  if (logicalSources.has(source)) {
    return true;
  }

  if (!workspaceRelativePathSchema.safeParse(source).success) {
    return false;
  }

  // 路径授权先要求命中至少一个 include，再检查所有 exclude；exclude 最终优先，
  // 因此宽范围 include 中的生成目录等敏感子树仍会被稳定拒绝。
  const included = contract.scope.include.some(
    (scopePath) => isSameOrChildPath(source, scopePath),
  );
  const excluded = contract.scope.exclude.some(
    (scopePath) => isSameOrChildPath(source, scopePath),
  );
  return included && !excluded;
}

// 单对象 schema 先保证 Contract 与 Result 各自结构有效，随后在同一个 superRefine 中
// 检查二者之间的身份、角色、证据来源和状态不变量。这里不在首个失败处提前返回，
// 而是持续 addIssue，让调用方一次拿到所有可定位的 Zod issue，并保持统一 ZodError 边界。
const subagentExecutionSchema = z.object({
  contract: subagentContractSchema,
  result: subagentResultSchema,
}).strict().superRefine(({ contract, result }, context) => {
  if (result.contractId !== contract.id) {
    context.addIssue({
      code: "custom",
      path: ["result", "contractId"],
      message: "Result contractId does not match the contract",
    });
  }

  if (result.role !== contract.role) {
    context.addIssue({
      code: "custom",
      path: ["result", "role"],
      message: "Result role does not match the contract",
    });
  }

  result.evidence.forEach((evidence, index) => {
    if (!isEvidenceSourceAllowed(contract, evidence.source)) {
      context.addIssue({
        code: "custom",
        path: ["result", "evidence", index, "source"],
        message: "Evidence source is outside the contract scope",
      });
    }
  });

  // completed 表示执行成功，因此必须同时满足无错误与完整证据；其余终态则必须提供
  // 至少一个结构化错误说明失败原因。两条分支互斥，防止成功状态夹带错误，或失败状态
  // 在没有可诊断信息的情况下越过 Contract/Result 边界。
  if (result.status === "completed") {
    if (result.errors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["result", "errors"],
        message: "Completed results cannot contain errors",
      });
    }

    if (result.evidence.length < contract.evidenceRequirements.minimumCount) {
      context.addIssue({
        code: "custom",
        path: ["result", "evidence"],
        message: "Completed result does not meet minimum evidence count",
      });
    }

    const evidenceKinds = new Set(result.evidence.map((item) => item.kind));
    for (const requiredKind of contract.evidenceRequirements.requiredKinds) {
      if (!evidenceKinds.has(requiredKind)) {
        context.addIssue({
          code: "custom",
          path: ["result", "evidence"],
          message: `Completed result is missing evidence kind: ${requiredKind}`,
        });
      }
    }
  } else if (result.errors.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["result", "errors"],
      message: "Unsuccessful results must contain a structured error",
    });
  }
});

export function validateSubagentResult(
  contract: unknown,
  result: unknown,
): SubagentResult {
  return subagentExecutionSchema.parse({ contract, result }).result;
}
