import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODING_TASK_TYPES,
  codingTaskClassificationSchema,
} from "../../src/modes/coding/coding-task.js";

test("accepts every supported coding task classification", () => {
  for (const taskType of CODING_TASK_TYPES) {
    const parsed = codingTaskClassificationSchema.parse({
      taskType,
      objective: "Inspect the repository",
      reason: "The request matches this workflow",
    });
    assert.equal(parsed.taskType, taskType);
  }
});

test("rejects an unknown task classification", () => {
  assert.equal(codingTaskClassificationSchema.safeParse({
    taskType: "implement_change",
    objective: "Edit files",
    reason: "Unsupported in this milestone",
  }).success, false);
});
