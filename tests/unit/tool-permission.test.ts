import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveShellPermission } from "../../src/agents/tools/tool-permission.js";

const rules = {
  allowedExecutables: [
    { executable: "git", argsPrefix: ["status"] },
    { executable: "rg", argsPrefix: [] },
  ],
  approvalRequiredExecutables: [
    { executable: "git", argsPrefix: ["push"] },
  ],
};

test("distinguishes allowed, approval-required, and denied commands", () => {
  assert.equal(
    resolveShellPermission({ executable: "git", args: ["status"] }, rules),
    "allowed",
  );
  assert.equal(
    resolveShellPermission(
      { executable: "git", args: ["status", "--short"] },
      rules,
    ),
    "allowed",
  );
  assert.equal(
    resolveShellPermission(
      { executable: "git", args: ["push", "origin", "main"] },
      rules,
    ),
    "approval_required",
  );
  assert.equal(
    resolveShellPermission({ executable: "git", args: ["clean", "-fd"] }, rules),
    "denied",
  );
});

test("exact rules reject arguments beyond the declared command", () => {
  const exactRules = {
    allowedExecutables: [{
      executable: "npm",
      argsPrefix: ["run", "build"],
      argsMatch: "exact" as const,
    }],
    approvalRequiredExecutables: [],
  };

  assert.equal(
    resolveShellPermission(
      { executable: "npm", args: ["run", "build"] },
      exactRules,
    ),
    "allowed",
  );
  assert.equal(
    resolveShellPermission(
      {
        executable: "npm",
        args: ["run", "build", "--", "--outDir", "/tmp/out"],
      },
      exactRules,
    ),
    "denied",
  );
});

test("an empty argsPrefix allows every argument for the exact executable", () => {
  assert.equal(
    resolveShellPermission({ executable: "rg", args: ["contract", "src"] }, rules),
    "allowed",
  );
  assert.equal(
    resolveShellPermission({ executable: "rg-other", args: [] }, rules),
    "denied",
  );
});

test("approval-required wins if an unchecked caller supplies overlapping rules", () => {
  assert.equal(
    resolveShellPermission(
      { executable: "git", args: ["push"] },
      {
        allowedExecutables: [{ executable: "git", argsPrefix: [] }],
        approvalRequiredExecutables: [
          { executable: "git", argsPrefix: ["push"] },
        ],
      },
    ),
    "approval_required",
  );
});
