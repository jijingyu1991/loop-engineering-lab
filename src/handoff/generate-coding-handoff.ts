import { join } from "node:path";

import type { CodingRunResult } from "../modes/coding/coding-state.js";
import type { TraceEvent } from "../trace/trace-event.js";
import { buildCodingHandoffArtifact } from "./build-coding-handoff-artifact.js";
import { renderHandoffMarkdown } from "./render-handoff-markdown.js";
import { writeHandoffFile } from "./write-handoff-file.js";

export async function generateCodingHandoff(input: {
  request: string;
  result: CodingRunResult;
  trace: readonly TraceEvent[];
  workspaceRoot: string;
  writer?: typeof writeHandoffFile;
}): Promise<string> {
  const handoffPath = join(input.workspaceRoot, "handoff.md");
  const artifact = buildCodingHandoffArtifact({
    request: input.request,
    result: input.result,
    trace: input.trace,
  });
  const markdown = renderHandoffMarkdown(artifact);

  // pipeline 返回明确路径供组合层或测试确认，但不把路径加入 CodingRunResult，
  // 避免 handoff 基础设施改变现有 CLI JSON 合同。
  await (input.writer ?? writeHandoffFile)({ handoffPath, markdown });
  return handoffPath;
}
