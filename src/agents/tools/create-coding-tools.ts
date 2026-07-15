import type { TraceWriter } from "../../trace/jsonl-trace-writer.js";
import { createReadOnlyFileTool } from "./read-only-file-tool.js";
import { createSearchTool } from "./search-tool.js";
import { createShellTool } from "./shell-tool.js";
import type { ToolOutcomeRecorder } from "./tool-outcome-recorder.js";
import type { ToolRuntimeConfig } from "./tool-runtime-config.js";

/**
 * coding 模式只装配 read/search/shell。这里不导入 createFileTool，使 writable
 * file tool 不会进入 Agent 的工具表；shell 的命令边界仍由既有 runtime 配置控制。
 */
export function createCodingTools(
  runtime: ToolRuntimeConfig,
  traceWriter: TraceWriter,
  outcomeRecorder: ToolOutcomeRecorder,
) {
  return [
    createReadOnlyFileTool(runtime, traceWriter, outcomeRecorder),
    createSearchTool(runtime, traceWriter, outcomeRecorder),
    createShellTool(runtime, traceWriter, outcomeRecorder),
  ];
}
