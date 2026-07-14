import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { createFileTool } from "./file-tool.js";
import { createSearchTool } from "./search-tool.js";
import { createShellTool } from "./shell-tool.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";

/**
 * 三个工具共享同一份 runtime 与 trace writer，保证 workspace 权限根、输出上限和
 * 审计目的地不会因为独立构造而漂移。返回顺序也保持稳定，便于阅读模型工具表。
 */
export function createAgentTools(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return [
    createFileTool(runtime, traceWriter, outcomeRecorder),
    createSearchTool(runtime, traceWriter, outcomeRecorder),
    createShellTool(runtime, traceWriter, outcomeRecorder),
  ];
}
