import { z } from "zod";

// evidence 与 mode-neutral WorkflowEvidence 保持同形，让 adapter 无需二次翻译即可交给工作流。
export const codingOutputSchema = z.object({
  output: z.string().min(1),
  evidence: z.array(z.object({
    kind: z.string().min(1),
    source: z.string().min(1),
    summary: z.string().min(1),
  })),
});
