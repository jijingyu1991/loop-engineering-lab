import { z } from "zod";

// 当前里程碑只允许分类到只读、分析型 coding 工作流；实际文件修改会在后续能力中显式引入。
export const CODING_TASK_TYPES = [
  "explain_module",
  "find_related_files",
  "diagnose_test_failure",
  "propose_implementation_plan",
] as const;

export const codingTaskClassificationSchema = z.object({
  taskType: z.enum(CODING_TASK_TYPES),
  objective: z.string().min(1),
  reason: z.string().min(1),
});

export type CodingTaskClassification = z.infer<
  typeof codingTaskClassificationSchema
>;

export type CodingTaskType = CodingTaskClassification["taskType"];

// 分类器通过 Promise 边界与未来的 Agent 实现对齐，同时保持合同本身与具体 provider 无关。
export type CodingClassifier = (
  request: string,
) => Promise<CodingTaskClassification>;
