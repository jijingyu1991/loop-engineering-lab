import { tool } from "@openai/agents";
import { z } from "zod";

import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { TraceInfrastructureError } from "../../trace/trace-infrastructure-error.js";
import { executeFileTool } from "./file-tool.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";
import { createToolError, type ToolResult } from "./tool-result.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";
import { traceToolExecution } from "./trace-tool-execution.js";

/**
 * coding Agent 只接收读取所需的 path。strict 阻止 action、content、overwrite
 * 等 writable file tool 字段被静默丢弃，从 schema 边界上拒绝写入意图。
 */
export const readOnlyFileInputSchema = z.object({
  path: z.string().min(1),
}).strict();

function adapterFailure(): ToolResult<never> {
  return {
    ok: false,
    error: createToolError({
      type: "invalid_input",
      message: "The read-only file tool arguments failed schema validation.",
      retryable: false,
      userActionRequired: false,
      suggestedNextStep: "Correct the read-only file tool arguments to match its schema.",
      evidence: { tool: "file", operation: "adapter" },
    }),
  };
}

export function createReadOnlyFileTool(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return tool({
    name: "workspace_file_read",
    description: "Read a UTF-8 file inside the configured workspace.",
    parameters: readOnlyFileInputSchema,
    execute: (input) =>
      traceToolExecution({
        tool: "file",
        operation: "read",
        inputSummary: { path: input.path },
        traceWriter,
        outcomeRecorder,
        // 底层 executor 仍复用经过路径约束与输出上限验证的 file adapter，
        // 但这里固定构造 read action，模型没有任何途径选择 write 分支。
        execute: () => executeFileTool({ action: "read", path: input.path }, runtime),
      }),
    errorFunction: async (_context, error) => {
      // SDK 会把 execute 的异常交给 errorFunction。trace 存储故障不是模型参数错误，
      // 必须在 adapter fallback 写入第二条 trace 之前原样抛出，否则一次性故障会被
      // 后续成功的 fallback trace 掩盖成 invalid_input。
      if (error instanceof TraceInfrastructureError) {
        throw error;
      }
      return JSON.stringify(
        await traceToolExecution({
          tool: "file",
          operation: "adapter",
          inputSummary: { validation: "failed" },
          traceWriter,
          outcomeRecorder,
          execute: async () => adapterFailure(),
        }),
      );
    },
  });
}
