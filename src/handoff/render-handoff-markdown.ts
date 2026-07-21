import type {
  HandoffArtifact,
  HandoffCompletedStep,
  HandoffEvidence,
  HandoffFailedAttempt,
} from "./handoff-artifact.js";

const NONE_RECORDED = "None recorded.";

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inlineCode(value: string): string {
  // Artifact 通常已经过 builder 规范化，但 renderer 仍独立保护 Markdown 边界。
  // backtick 改成普通撇号后，动态 step/path 不会提前结束 inline code span。
  return `\`${singleLine(value).replaceAll("`", "'")}\``;
}

function renderCompletedStep(item: HandoffCompletedStep): string {
  const evidence = item.evidence.length > 0
    ? item.evidence.map(singleLine).join("; ")
    : "Completed without recorded evidence.";
  return `- ${inlineCode(item.step)} — ${evidence}`;
}

function renderEvidence(item: HandoffEvidence): string {
  return `- ${inlineCode(item.kind)} — ${inlineCode(item.source)}: ${singleLine(item.summary)}`;
}

function renderFailedAttempt(item: HandoffFailedAttempt): string {
  const next = item.suggestedNextStep === null
    ? ""
    : ` Next: ${singleLine(item.suggestedNextStep)}`;
  return `- ${inlineCode(item.kind)}: ${singleLine(item.summary)}${next}`;
}

function renderList<T>(
  items: readonly T[],
  renderItem: (item: T) => string,
): string {
  return items.length === 0
    ? NONE_RECORDED
    : items.map(renderItem).join("\n");
}

export function renderHandoffMarkdown(artifact: HandoffArtifact): string {
  const taskType = artifact.currentState.taskType ?? "none";
  const finalOutput = artifact.currentState.finalOutput === null
    ? NONE_RECORDED
    : singleLine(artifact.currentState.finalOutput);

  // 固定标题顺序是 handoff 的外部合同。通过一次 join 生成完整字符串，也让 writer
  // 能在 rename 前把全量内容写入临时文件，不会暴露部分完成的 artifact。
  return [
    "# Task Handoff",
    "",
    "## Goal",
    "",
    singleLine(artifact.goal),
    "",
    "## Current State",
    "",
    `- Status: ${inlineCode(artifact.currentState.status)}`,
    `- Task type: ${inlineCode(taskType)}`,
    `- Stop reason: ${inlineCode(artifact.currentState.stopReason)}`,
    `- Completed workflow steps: ${artifact.currentState.completedSteps}`,
    `- Trace: ${inlineCode(artifact.currentState.tracePath)}`,
    "",
    `Final output: ${finalOutput}`,
    "",
    "## Completed Steps",
    "",
    renderList(artifact.completedSteps, renderCompletedStep),
    "",
    "## Open Questions",
    "",
    renderList(artifact.openQuestions, (question) => `- ${singleLine(question)}`),
    "",
    "## Evidence",
    "",
    renderList(artifact.evidence, renderEvidence),
    "",
    "## Failed Attempts",
    "",
    renderList(artifact.failedAttempts, renderFailedAttempt),
    "",
    "## Next Recommended Action",
    "",
    singleLine(artifact.nextRecommendedAction),
    "",
  ].join("\n");
}
