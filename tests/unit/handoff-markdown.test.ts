import assert from "node:assert/strict";
import { test } from "node:test";

import type { HandoffArtifact } from "../../src/handoff/handoff-artifact.js";
import { renderHandoffMarkdown } from "../../src/handoff/render-handoff-markdown.js";

function createArtifact(
  overrides: Partial<HandoffArtifact> = {},
): HandoffArtifact {
  return {
    goal: "Diagnose the protected fixture",
    currentState: {
      status: "blocked",
      taskType: "diagnose_test_failure",
      stopReason: "user_action_required",
      completedSteps: 2,
      finalOutput: "May I inspect the protected fixture?",
      tracePath: "traces/coding-run.jsonl",
    },
    completedSteps: [{
      step: "understand_request",
      evidence: ["classification_objective (diagnose_test_failure): Diagnose failure."],
    }],
    openQuestions: ["May I inspect the protected fixture?"],
    evidence: [{
      kind: "file",
      source: "src/cli.ts",
      summary: "Entry point inspected.",
    }],
    failedAttempts: [{
      kind: "terminal:user_action_required",
      summary: "Coding run stopped with user_action_required.",
      suggestedNextStep: null,
    }],
    nextRecommendedAction: "Answer the first open question, then rerun the Coding task.",
    ...overrides,
  };
}

test("renders the stable seven-section handoff contract", () => {
  const markdown = renderHandoffMarkdown(createArtifact());
  const headings = [...markdown.matchAll(/^## (.+)$/gm)]
    .map((match) => match[1]);

  assert.deepEqual(headings, [
    "Goal",
    "Current State",
    "Completed Steps",
    "Open Questions",
    "Evidence",
    "Failed Attempts",
    "Next Recommended Action",
  ]);
  assert.match(markdown, /^# Task Handoff$/m);
  assert.match(markdown, /- Status: `blocked`/);
  assert.match(markdown, /- Task type: `diagnose_test_failure`/);
  assert.match(markdown, /- Stop reason: `user_action_required`/);
  assert.match(markdown, /- Trace: `traces\/coding-run\.jsonl`/);
  assert.match(
    markdown,
    /- `file` — `src\/cli\.ts`: Entry point inspected\./,
  );
  assert.match(
    markdown,
    /- `terminal:user_action_required`: Coding run stopped with user_action_required\./,
  );
  assert.ok(markdown.endsWith("\n"));
});

test("renders explicit empty states without dropping any section", () => {
  const markdown = renderHandoffMarkdown(createArtifact({
    currentState: {
      status: "completed",
      taskType: null,
      stopReason: "classification_failed",
      completedSteps: 0,
      finalOutput: null,
      tracePath: "traces/empty.jsonl",
    },
    completedSteps: [],
    openQuestions: [],
    evidence: [],
    failedAttempts: [],
  }));

  assert.match(markdown, /- Task type: `none`/);
  assert.match(markdown, /Final output: None recorded\./);
  assert.equal(
    [...markdown.matchAll(/None recorded\./g)].length,
    5,
  );
});

test("neutralizes backticks in inline-code labels", () => {
  const markdown = renderHandoffMarkdown(createArtifact({
    evidence: [{
      kind: "file`kind",
      source: "src/`unsafe`.ts",
      summary: "Safe summary.",
    }],
  }));

  assert.doesNotMatch(markdown, /`file`kind`/);
  assert.match(markdown, /`file'kind` — `src\/'unsafe'\.ts`/);
});
