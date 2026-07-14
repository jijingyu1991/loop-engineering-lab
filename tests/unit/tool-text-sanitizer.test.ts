import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeToolText } from "../../src/agents/tools/sanitize-tool-text.js";

test("redacts configured credentials and common bearer token forms", () => {
  const sanitized = sanitizeToolText(
    "key=secret-value Authorization: Bearer abcdefghijklmnop",
    { API_SECRET: "secret-value" },
  );

  assert.equal(sanitized.includes("secret-value"), false);
  assert.equal(sanitized.includes("abcdefghijklmnop"), false);
  assert.match(sanitized, /\[REDACTED\]/);
});
