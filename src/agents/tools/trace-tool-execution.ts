import type {
  LocalToolName,
} from "../../trace/trace-event.js";
import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import type {
  ToolEvidence,
  ToolResult,
} from "./tool-result.js";

export interface TraceToolExecutionInput<T> {
  tool: LocalToolName;
  operation: string;
  inputSummary: ToolEvidence;
  traceWriter: TraceWriter;
  execute: () => Promise<ToolResult<T>>;
  now?: () => string;
  clock?: () => number;
}

/**
 * 模型输出与 trace 必须共享同一份 ToolResult，不能分别分类同一个异常。这个 wrapper
 * 因此只负责生命周期事件：执行器生成一次结果，成功或失败事件直接引用其中的
 * evidence/error。trace 写入失败有意不捕获，因为缺少审计链的调用不能继续报告成功。
 */
export async function traceToolExecution<T>(
  input: TraceToolExecutionInput<T>,
): Promise<ToolResult<T>> {
  const now = input.now ?? (() => new Date().toISOString());
  const clock = input.clock ?? (() => performance.now());
  const startedAt = clock();

  await input.traceWriter.write({
    event: "tool_started",
    timestamp: now(),
    tool: input.tool,
    operation: input.operation,
    input: input.inputSummary,
  });

  const result = await input.execute();
  const durationMs = Math.max(0, clock() - startedAt);
  const timestamp = now();

  if (result.ok) {
    await input.traceWriter.write({
      event: "tool_completed",
      timestamp,
      tool: input.tool,
      operation: input.operation,
      durationMs,
      evidence: result.evidence,
    });
  } else {
    await input.traceWriter.write({
      event: "tool_failed",
      timestamp,
      tool: input.tool,
      operation: input.operation,
      durationMs,
      error: result.error,
    });
  }

  return result;
}
