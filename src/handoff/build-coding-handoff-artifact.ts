import type { CodingRunResult } from "../modes/coding/coding-state.js";
import type { TraceEvent } from "../trace/trace-event.js";
import {
  HANDOFF_LIMITS,
  type HandoffArtifact,
  type HandoffCompletedStep,
  type HandoffEvidence,
  type HandoffFailedAttempt,
} from "./handoff-artifact.js";

const TRUNCATION_MARKER = "… [truncated]";

function redactSensitiveText(value: string): string {
  // handoff 会复述用户目标和结构化摘要，因此在最靠近文本入口处统一消毒。
  // 这里只识别常见 credential 形态；不会扫描环境变量或复制工具 evidence 原对象。
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
}

export function compactText(value: string, maxChars: number): string {
  const compacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }

  // marker 也计入预算，保证每个调用方都能依赖严格的最大长度。
  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${compacted.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

function evidenceKey(evidence: HandoffEvidence): string {
  return `${evidence.kind}\u0000${evidence.source}\u0000${evidence.summary}`;
}

function toHandoffEvidence(input: HandoffEvidence): HandoffEvidence {
  return {
    kind: compactText(input.kind, HANDOFF_LIMITS.evidenceChars),
    source: compactText(input.source, HANDOFF_LIMITS.evidenceChars),
    summary: compactText(input.summary, HANDOFF_LIMITS.evidenceChars),
  };
}

function collectCompletedSteps(
  trace: readonly TraceEvent[],
): HandoffCompletedStep[] {
  const steps = new Map<string, HandoffCompletedStep>();

  for (const event of trace) {
    if (event.event !== "workflow_step_completed") {
      continue;
    }

    const existing = steps.get(event.step) ?? {
      step: compactText(event.step, HANDOFF_LIMITS.evidenceChars),
      evidence: [],
    };
    const seen = new Set(existing.evidence);
    for (const item of event.evidence) {
      const summary = compactText(
        `${item.kind} (${item.source}): ${item.summary}`,
        HANDOFF_LIMITS.evidenceChars,
      );
      if (!seen.has(summary)) {
        existing.evidence.push(summary);
        seen.add(summary);
      }
    }
    steps.set(event.step, existing);
  }

  return [...steps.values()].slice(0, HANDOFF_LIMITS.completedSteps);
}

function collectEvidence(trace: readonly TraceEvent[]): HandoffEvidence[] {
  const evidence: HandoffEvidence[] = [];
  const seen = new Set<string>();

  // 越靠后的 workflow completion 越接近最终接受状态。反向读取可让通过 reviewer
  // 的 evidence 优先于早期 revision attempt，同时仍然只消费结构化小字段。
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event?.event !== "workflow_step_completed") {
      continue;
    }
    for (const item of event.evidence) {
      const normalized = toHandoffEvidence(item);
      const key = evidenceKey(normalized);
      if (!seen.has(key)) {
        evidence.push(normalized);
        seen.add(key);
      }
      if (evidence.length === HANDOFF_LIMITS.evidence) {
        return evidence;
      }
    }
  }
  return evidence;
}

function readRevisionInstructions(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const extensions = value as Record<string, unknown>;
  if (
    extensions.decision !== "revise"
    || !Array.isArray(extensions.revisionInstructions)
  ) {
    return [];
  }
  return extensions.revisionInstructions.filter(
    (item): item is string => typeof item === "string",
  );
}

function collectFailedAttempts(
  trace: readonly TraceEvent[],
  result: CodingRunResult,
): HandoffFailedAttempt[] {
  const attempts: HandoffFailedAttempt[] = [];

  // 失败按时间倒序呈现，接手者首先看到离终态最近、通常也最可行动的原因。
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event?.event === "tool_failed") {
      attempts.push({
        kind: compactText(
          `tool:${event.tool}/${event.operation}`,
          HANDOFF_LIMITS.failedAttemptChars,
        ),
        summary: compactText(
          event.error.message,
          HANDOFF_LIMITS.failedAttemptChars,
        ),
        suggestedNextStep: compactText(
          event.error.suggestedNextStep,
          HANDOFF_LIMITS.failedAttemptChars,
        ) || null,
      });
    } else if (event?.event === "workflow_step_failed") {
      attempts.push({
        kind: compactText(
          `workflow:${event.step}`,
          HANDOFF_LIMITS.failedAttemptChars,
        ),
        summary: compactText(
          event.error.message,
          HANDOFF_LIMITS.failedAttemptChars,
        ),
        suggestedNextStep: null,
      });
    } else if (event?.event === "subagent_finished") {
      const reviewerResult = event.result;
      if (reviewerResult.status === "completed") {
        const revisionInstructions = readRevisionInstructions(
          reviewerResult.extensions,
        );
        if (revisionInstructions.length > 0) {
          attempts.push({
            kind: "reviewer:revise",
            summary: compactText(
              reviewerResult.summary,
              HANDOFF_LIMITS.failedAttemptChars,
            ),
            suggestedNextStep: compactText(
              revisionInstructions.join(" "),
              HANDOFF_LIMITS.failedAttemptChars,
            ),
          });
        }
      } else {
        attempts.push({
          kind: compactText(
            `reviewer:${reviewerResult.status}`,
            HANDOFF_LIMITS.failedAttemptChars,
          ),
          summary: compactText(
            reviewerResult.summary,
            HANDOFF_LIMITS.failedAttemptChars,
          ),
          suggestedNextStep: reviewerResult.errors.some((error) => error.retryable)
            ? "Retry the reviewer."
            : null,
        });
      }
    }

    if (attempts.length === HANDOFF_LIMITS.failedAttempts) {
      break;
    }
  }

  // 有些终态在 classifier 或 composition 边界产生，没有对应的 step/tool failure。
  // 合成稳定条目能避免 handoff 显示 failed/blocked 却声称没有失败信息。
  if (
    attempts.length === 0
    && (result.status === "failed" || result.status === "blocked")
  ) {
    attempts.push({
      kind: `terminal:${result.stopReason}`,
      summary: `Coding run stopped with ${result.stopReason}.`,
      suggestedNextStep: null,
    });
  }
  return attempts;
}

function createNextRecommendedAction(
  result: CodingRunResult,
  openQuestions: readonly string[],
  failedAttempts: readonly HandoffFailedAttempt[],
): string {
  let action: string;
  if (
    result.status === "blocked"
    && result.stopReason === "user_action_required"
    && openQuestions.length > 0
  ) {
    action = "Answer the first open question, then rerun the Coding task.";
  } else if (result.status === "blocked") {
    action = `Resolve the ${result.stopReason} blocker, then rerun the Coding task.`;
  } else if (result.status === "failed") {
    action = failedAttempts.find((attempt) => attempt.suggestedNextStep !== null)
      ?.suggestedNextStep
      ?? `Fix the ${result.stopReason} failure, then rerun the Coding task.`;
  } else if (result.status === "cancelled") {
    action = "Confirm the goal is still valid, then continue after the last completed step.";
  } else {
    action = "Review the final output and continue with its next action; if none is stated, verify the evidence and close the task.";
  }
  return compactText(action, HANDOFF_LIMITS.nextActionChars);
}

export function buildCodingHandoffArtifact(input: {
  request: string;
  result: CodingRunResult;
  trace: readonly TraceEvent[];
}): HandoffArtifact {
  const openQuestions = input.result.status === "blocked"
      && input.result.stopReason === "user_action_required"
      && input.result.finalOutput !== null
    ? [compactText(input.result.finalOutput, HANDOFF_LIMITS.finalOutputChars)]
      .filter((item) => item.length > 0)
      .slice(0, HANDOFF_LIMITS.openQuestions)
    : [];
  const failedAttempts = collectFailedAttempts(input.trace, input.result);

  return {
    goal: compactText(input.request, HANDOFF_LIMITS.goalChars),
    currentState: {
      status: input.result.status,
      taskType: input.result.taskType,
      stopReason: input.result.stopReason,
      completedSteps: input.result.completedSteps,
      finalOutput: input.result.finalOutput === null
        ? null
        : compactText(
          input.result.finalOutput,
          HANDOFF_LIMITS.finalOutputChars,
        ),
      tracePath: compactText(input.result.tracePath, HANDOFF_LIMITS.evidenceChars),
    },
    completedSteps: collectCompletedSteps(input.trace),
    openQuestions,
    evidence: collectEvidence(input.trace),
    failedAttempts,
    nextRecommendedAction: createNextRecommendedAction(
      input.result,
      openQuestions,
      failedAttempts,
    ),
  };
}
