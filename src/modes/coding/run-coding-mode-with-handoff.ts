import { generateCodingHandoff } from "../../handoff/generate-coding-handoff.js";
import type { TraceEvent } from "../../trace/trace-event.js";
import type { CodingRunResult } from "./coding-state.js";

export async function runCodingModeWithHandoff(input: {
  request: string;
  workspaceRoot: string;
  run: () => Promise<CodingRunResult>;
  traceSnapshot: () => readonly TraceEvent[];
  generate?: typeof generateCodingHandoff;
}): Promise<CodingRunResult> {
  // 只有真实 terminal result 返回后才允许覆盖 handoff。若 run 因 trace 基础设施等
  // 原因直接 reject，旧文件仍描述上一次完整运行，不会被虚构的终态替换。
  const result = await input.run();
  const trace = input.traceSnapshot();
  await (input.generate ?? generateCodingHandoff)({
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    result,
    trace,
  });
  return result;
}
