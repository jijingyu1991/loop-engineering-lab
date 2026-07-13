# Structured Tool Error Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文件、搜索和 shell 工具实现统一、模型可见且可追踪的结构化错误 contract，并在命令行中完成 shell 用户批准流程。

**Architecture:** 领域层用 `ToolResult<T>` 判别联合表达成功与失败；三个纯执行器共享 workspace path guard、权限策略和 traced wrapper，再由薄 Agents SDK adapter 暴露给 Actor Agent。CLI 是唯一 composition root：解析全局 tool 配置、创建 trace writer、组装 tools，并通过可注入的终端 approval handler 恢复被 SDK 中断的 run。

**Tech Stack:** TypeScript 7、Node.js 22、ESM、Zod 4、OpenAI Agents SDK 0.13、`node:test`、`node:child_process`、ripgrep。

## Global Constraints

- 使用 strict TypeScript、`.js` ESM import、两空格缩进、双引号和分号。
- 重要逻辑必须有详细中文注释，说明设计意图、数据流、失败处理和边界条件。
- `tools.workspaceRoot` 可配置，默认 `process.cwd()`；所有文件、搜索和 shell cwd 必须位于该根内。
- workspace 外操作始终拒绝，用户批准不能提升该权限边界。
- shell 使用 `executable + args[]` 和 `spawn(..., { shell: false })`，不接受 shell 字符串。
- shell 规则由 `allowedExecutables` 与 `approvalRequiredExecutables` 的 `{ executable, argsPrefix }` 组成；未匹配规则的调用拒绝。
- 工具不自动重试；`retryable` 和 evidence 必须写入 trace。
- 不运行 `RUN_LIVE_LOOP=1 npm run test:integration`。

---

## File Map

- Create `src/agents/tools/tool-result.ts`: provider-neutral result、error、evidence 类型和错误工厂。
- Create `src/agents/tools/tool-runtime-config.ts`: 从已解析 LoopConfig 构造绝对 workspace runtime 配置。
- Create `src/agents/tools/tool-permission.ts`: shell 参数前缀三态权限判定。
- Create `src/agents/tools/resolve-workspace-path.ts`: lexical + realpath workspace 防逃逸校验。
- Create `src/agents/tools/trace-tool-execution.ts`: 工具生命周期 trace wrapper。
- Create `src/agents/tools/file-tool.ts`: 文件 read/write 执行器和 SDK tool。
- Create `src/agents/tools/search-tool.ts`: `rg` 搜索执行器和 SDK tool。
- Create `src/agents/tools/shell-tool.ts`: shell 执行器、权限判定和动态 approval predicate。
- Create `src/agents/tools/create-agent-tools.ts`: 三个 SDK tools 的组合工厂。
- Create `src/agents/terminal-approval-handler.ts`: CLI `y/N` 审批和非 TTY 默认拒绝。
- Modify `src/config/config-schema.ts`: tool schema/defaults/规则冲突校验。
- Modify `src/trace/trace-event.ts`: tool 与 approval trace events。
- Modify `src/agents/create-agent.ts`: 接收已组装 tools。
- Modify `src/loop/stages/act.ts`: 处理 SDK interruptions 并恢复同一 RunState。
- Modify `src/cli.ts`: 组装 runtime、tools、terminal handler。
- Modify `config/loop.config.json`: 显式记录默认 tool 权限。
- Modify `README.md`: 说明 contract、workspace 与终端审批。
- Create unit tests named after each component under `tests/unit/`.

### Task 1: Configuration and Provider-Neutral Result Contract

**Files:**
- Create: `src/agents/tools/tool-result.ts`
- Create: `src/agents/tools/tool-runtime-config.ts`
- Modify: `src/config/config-schema.ts`
- Modify: `tests/unit/config.test.ts`
- Create: `tests/unit/tool-result.test.ts`

**Interfaces:**
- Produces: `ToolResult<T>`, `ToolError`, `ToolErrorType`, `ToolEvidence`, `createToolError(...)`.
- Produces: `ExecutableRule`, `ToolRuntimeConfig`, `createToolRuntimeConfig(config, cwd)`.
- Consumes later: all tool executors, trace events, approval rejection formatter, CLI composition.

- [ ] **Step 1: Write failing configuration and contract tests**

Add tests that assert the legacy config defaults to `workspaceRoot: "."`, validates rule objects, and rejects an allow rule that shadows an approval rule:

```ts
test("defaults tool configuration for legacy config files", () => {
  const parsed = parseLoopConfig(validConfig);
  assert.equal(parsed.tools.workspaceRoot, ".");
  assert.deepEqual(parsed.tools.shell.allowedExecutables, [
    { executable: "node", argsPrefix: [] },
    { executable: "npm", argsPrefix: ["test"] },
    { executable: "npm", argsPrefix: ["run", "build"] },
    { executable: "git", argsPrefix: ["status"] },
    { executable: "rg", argsPrefix: [] },
  ]);
});

test("rejects an allow rule that shadows an approval rule", () => {
  assert.throws(
    () => parseLoopConfig({
      ...validConfig,
      tools: {
        workspaceRoot: ".",
        shell: {
          allowedExecutables: [{ executable: "git", argsPrefix: [] }],
          approvalRequiredExecutables: [
            { executable: "git", argsPrefix: ["push"] },
          ],
        },
      },
    }),
    /Ambiguous shell permission rules/,
  );
});

test("creates every error with the complete model-visible contract", () => {
  const error = createToolError({
    type: "timeout",
    message: "Command timed out",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Retry once or narrow the command.",
    evidence: { tool: "shell", operation: "execute", durationMs: 10_000 },
  });
  assert.deepEqual(error, {
    type: "timeout",
    message: "Command timed out",
    retryable: true,
    userActionRequired: false,
    suggestedNextStep: "Retry once or narrow the command.",
    evidence: { tool: "shell", operation: "execute", durationMs: 10_000 },
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/config.test.ts tests/unit/tool-result.test.ts`

Expected: FAIL because `tools`, `createToolError`, and the new modules do not exist.

- [ ] **Step 3: Implement schema defaults, ambiguity validation, and contract types**

Use these exact public shapes:

```ts
export type ToolErrorType =
  | "invalid_input"
  | "path_outside_workspace"
  | "not_found"
  | "permission_denied"
  | "conflict"
  | "command_not_allowed"
  | "approval_required"
  | "approval_rejected"
  | "dependency_missing"
  | "timeout"
  | "process_failed"
  | "output_limit_exceeded"
  | "internal_error";

export type ToolEvidence = Record<
  string,
  string | number | boolean | null | string[]
>;

export interface ToolError {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  userActionRequired: boolean;
  suggestedNextStep: string;
  evidence: ToolEvidence;
}

export type ToolResult<T> =
  | { ok: true; data: T; evidence: ToolEvidence }
  | { ok: false; error: ToolError };

export function createToolError(error: ToolError): ToolError {
  return error;
}
```

Define `ExecutableRule` and runtime config exactly once:

```ts
export interface ExecutableRule {
  executable: string;
  argsPrefix: string[];
}

export interface ToolRuntimeConfig {
  workspaceRoot: string;
  file: { maxReadChars: number };
  search: { maxMatches: number; maxOutputChars: number };
  shell: {
    allowedExecutables: ExecutableRule[];
    approvalRequiredExecutables: ExecutableRule[];
    timeoutMs: number;
    maxOutputChars: number;
  };
}
```

The schema defaults must equal the approved spec. Its `superRefine` must reject rules from opposite lists when executable names match and either `argsPrefix` is a prefix of the other. `createToolRuntimeConfig` uses `resolve(cwd, config.tools.workspaceRoot)`.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/config.test.ts tests/unit/tool-result.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/config/config-schema.ts src/agents/tools/tool-result.ts src/agents/tools/tool-runtime-config.ts tests/unit/config.test.ts tests/unit/tool-result.test.ts
git commit -m "feat: define structured tool result contract"
```

### Task 2: Workspace Boundary Guard

**Files:**
- Create: `src/agents/tools/resolve-workspace-path.ts`
- Create: `tests/unit/workspace-path.test.ts`

**Interfaces:**
- Consumes: `ToolResult`, `ToolRuntimeConfig.workspaceRoot`.
- Produces: `resolveWorkspacePath({ workspaceRoot, requestedPath, mode }): Promise<ToolResult<ResolvedWorkspacePath>>`.

- [ ] **Step 1: Write failing path boundary tests**

Use `mkdtemp`, `mkdir`, `writeFile`, and `symlink` to cover an ordinary relative path, `../outside`, an absolute path, a symlink to an outside file, and a new write target beneath an in-workspace existing parent. Assert all exposed paths are relative and outside attempts return `path_outside_workspace`.

```ts
test("rejects a symlink whose real target is outside workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "tool-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

  const result = await resolveWorkspacePath({
    workspaceRoot: root,
    requestedPath: "link.txt",
    mode: "existing",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.type, "path_outside_workspace");
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/workspace-path.test.ts`

Expected: FAIL because the resolver module is missing.

- [ ] **Step 3: Implement lexical and realpath checks**

Use the signature:

```ts
export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export async function resolveWorkspacePath(input: {
  workspaceRoot: string;
  requestedPath: string;
  mode: "existing" | "new-file";
}): Promise<ToolResult<ResolvedWorkspacePath>>;
```

Normalize the workspace with `realpath`. Reject absolute requested paths before resolution. Confirm `relative(root, candidate)` is neither `..` nor starts with `../`. For existing paths compare their `realpath`; for new files walk upward until an existing parent is found and compare that parent's `realpath`. Convert `ENOENT` to `not_found`, `EACCES`/`EPERM` to `permission_denied`, and unknown failures to sanitized `internal_error`.

- [ ] **Step 4: Re-run path tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/workspace-path.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/agents/tools/resolve-workspace-path.ts tests/unit/workspace-path.test.ts
git commit -m "feat: enforce tool workspace boundary"
```

### Task 3: Tool Trace Events and Shared Wrapper

**Files:**
- Modify: `src/trace/trace-event.ts`
- Create: `src/agents/tools/trace-tool-execution.ts`
- Create: `tests/unit/tool-trace.test.ts`

**Interfaces:**
- Consumes: `TraceWriter`, `ToolResult<T>`, `ToolError`.
- Produces: five new trace event variants and `traceToolExecution<T>(...)`.

- [ ] **Step 1: Write failing trace tests**

Create an in-memory writer and assert success writes `tool_started` then `tool_completed`; failure writes `tool_started` then `tool_failed`, with the exact same error object and retry fields.

```ts
const result = await traceToolExecution({
  tool: "shell",
  operation: "execute",
  inputSummary: { executable: "node", cwd: "." },
  traceWriter,
  now: timestamps.shift!.bind(timestamps),
  execute: async () => ({ ok: false, error }),
});
assert.equal(result.ok, false);
const failed = traceWriter.events.at(-1);
assert.equal(failed?.event, "tool_failed");
if (failed?.event === "tool_failed") assert.deepEqual(failed.error, error);
```

- [ ] **Step 2: Run test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/tool-trace.test.ts`

Expected: FAIL because tool trace event types and wrapper are missing.

- [ ] **Step 3: Add event unions and wrapper**

Add `ToolStartedEvent`, `ToolCompletedEvent`, `ToolFailedEvent`, `ToolApprovalRequestedEvent`, and `ToolApprovalResolvedEvent` to `TraceEvent`. The wrapper signature is:

```ts
export async function traceToolExecution<T>(input: {
  tool: "file" | "search" | "shell";
  operation: string;
  inputSummary: ToolEvidence;
  traceWriter: TraceWriter;
  execute: () => Promise<ToolResult<T>>;
  now?: () => string;
}): Promise<ToolResult<T>>;
```

Compute `durationMs` from parsed timestamps or an injected monotonic `durationMs` clock; use a separate injected `clock?: () => number` if ISO subtraction makes the test unclear. Do not catch `traceWriter.write` failures.

- [ ] **Step 4: Re-run trace tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/tool-trace.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/trace/trace-event.ts src/agents/tools/trace-tool-execution.ts tests/unit/tool-trace.test.ts
git commit -m "feat: trace structured tool outcomes"
```

### Task 4: File Tool

**Files:**
- Create: `src/agents/tools/file-tool.ts`
- Create: `tests/unit/file-tool.test.ts`

**Interfaces:**
- Consumes: runtime config, workspace resolver, trace wrapper, Agents SDK `tool`.
- Produces: `executeFileTool(input, runtime)`, `createFileTool(runtime, traceWriter)`.

- [ ] **Step 1: Write failing file executor tests**

Cover read success; read over limit; create success; existing target with `overwrite: false`; overwrite success; missing parent; directory target; and symlink escape. Assert success evidence has no content and every failure has all five required contract fields.

```ts
test("returns a structured conflict instead of overwriting implicitly", async () => {
  await writeFile(join(root, "answer.txt"), "old", "utf8");
  const result = await executeFileTool(
    { action: "write", path: "answer.txt", content: "new", overwrite: false },
    runtime,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.type, "conflict");
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.userActionRequired, false);
    assert.match(result.error.suggestedNextStep, /overwrite/);
    assert.equal(result.error.evidence.path, "answer.txt");
  }
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/file-tool.test.ts`

Expected: FAIL because file tool does not exist.

- [ ] **Step 3: Implement executor and SDK adapter**

Use discriminated Zod parameters:

```ts
const fileToolParameters = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), path: z.string().min(1) }),
  z.object({
    action: z.literal("write"),
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().default(false),
  }),
]);
```

Read UTF-8 with byte and character counts. Atomic write uses `open(tempPath, "wx")`, `writeFile`, `close`, then `rename`; remove only the known temporary file in `finally`. Map filesystem codes to stable contract values. The SDK `errorFunction` must JSON-stringify an `internal_error` contract for unexpected adapter errors, so the model never receives a bare exception.

- [ ] **Step 4: Re-run file tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/file-tool.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/agents/tools/file-tool.ts tests/unit/file-tool.test.ts
git commit -m "feat: add workspace file tool"
```

### Task 5: Shell Permission Policy and Executor

**Files:**
- Create: `src/agents/tools/tool-permission.ts`
- Create: `src/agents/tools/shell-tool.ts`
- Create: `tests/unit/tool-permission.test.ts`
- Create: `tests/unit/shell-tool.test.ts`

**Interfaces:**
- Produces: `resolveShellPermission(input, config): "allowed" | "approval_required" | "denied"`.
- Produces: `executeShellTool(input, runtime)`, `createShellTool(runtime, traceWriter)`.

- [ ] **Step 1: Write failing permission and executor tests**

Test exact executable plus args-prefix matching, default deny, workspace rejection before approval, stdout/stderr separation, nonzero exit, missing executable, timeout, and output cap. Use `process.execPath` under a synthetic allow rule so tests do not depend on shell syntax.

```ts
test("distinguishes allowed, approval-required, and denied commands", () => {
  const rules = {
    allowedExecutables: [{ executable: "git", argsPrefix: ["status"] }],
    approvalRequiredExecutables: [
      { executable: "git", argsPrefix: ["push"] },
    ],
  };
  assert.equal(resolveShellPermission({ executable: "git", args: ["status"] }, rules), "allowed");
  assert.equal(resolveShellPermission({ executable: "git", args: ["push", "origin"] }, rules), "approval_required");
  assert.equal(resolveShellPermission({ executable: "git", args: ["clean", "-fd"] }, rules), "denied");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/tool-permission.test.ts tests/unit/shell-tool.test.ts`

Expected: FAIL because permission and shell modules do not exist.

- [ ] **Step 3: Implement policy and process lifecycle**

`resolveShellPermission` checks only validated, non-ambiguous rules and compares `args.slice(0, prefix.length)`. In `executeShellTool`, call `resolveWorkspacePath(..., mode: "existing")` for cwd before permission resolution. Spawn with:

```ts
spawn(input.executable, input.args, {
  cwd: resolved.data.absolutePath,
  shell: false,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Collect stdout/stderr independently. Kill once on timeout or combined output overflow. Resolve exactly once on `close` or `error`. Map `ENOENT` to `dependency_missing`, nonzero exit to `process_failed`, timeout to retryable `timeout`, overflow to `output_limit_exceeded`, and denied policy to `command_not_allowed`.

`createShellTool` supplies a dynamic `needsApproval` predicate that returns true only for `approval_required`. A workspace-invalid input must return false from the predicate and be rejected structurally by execution, so it never generates an approval interruption.

- [ ] **Step 4: Re-run shell tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/tool-permission.test.ts tests/unit/shell-tool.test.ts`

Expected: all tests PASS with no leaked child processes.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/agents/tools/tool-permission.ts src/agents/tools/shell-tool.ts tests/unit/tool-permission.test.ts tests/unit/shell-tool.test.ts
git commit -m "feat: add policy-controlled shell tool"
```

### Task 6: Search Tool

**Files:**
- Create: `src/agents/tools/search-tool.ts`
- Create: `tests/unit/search-tool.test.ts`

**Interfaces:**
- Produces: `executeSearchTool(input, runtime)`, `createSearchTool(runtime, traceWriter)`.
- Consumes: workspace resolver, `rg`, trace wrapper.

- [ ] **Step 1: Write failing search tests**

Create a temporary fixture tree and cover literal match, regex match, glob filter, no matches as `{ ok: true, matches: [] }`, invalid regex, workspace escape, max matches, and relative paths.

```ts
test("treats no matches as a successful empty result", async () => {
  const result = await executeSearchTool(
    { pattern: "missing-token", path: ".", regex: false },
    runtime,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data.matches, []);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/search-tool.test.ts`

Expected: FAIL because search tool does not exist.

- [ ] **Step 3: Implement rg argument construction and bounded parsing**

Invoke `rg --line-number --column --no-heading --color never`; add `--fixed-strings` when `regex` is false and `--glob <glob>` only when supplied. Parse each line into `{ path, line, column, text }`, converting paths to workspace-relative form. Exit 0 is matches, exit 1 is successful no-match, exit 2 with regex diagnostics is `invalid_input`, and spawn `ENOENT` is `dependency_missing`. Kill on caps and return `output_limit_exceeded` evidence with observed counts.

- [ ] **Step 4: Re-run search tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/search-tool.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/agents/tools/search-tool.ts tests/unit/search-tool.test.ts
git commit -m "feat: add bounded workspace search tool"
```

### Task 7: Terminal Approval and Run Resumption

**Files:**
- Create: `src/agents/terminal-approval-handler.ts`
- Modify: `src/loop/stages/act.ts`
- Modify: `src/agents/create-runner.ts`
- Create: `tests/unit/terminal-approval-handler.test.ts`
- Create: `tests/unit/act-approval.test.ts`

**Interfaces:**
- Produces: `ApprovalDecision = "approved" | "rejected" | "unavailable"`.
- Produces: `createTerminalApprovalHandler({ input, output, isTTY })`.
- Extends: `ActInput` with `approvalHandler`, `traceWriter`, and injectable runner interface sufficient for initial and resumed runs.

- [ ] **Step 1: Write failing terminal and resumption tests**

Use `Readable.from(["yes\n"])` and a captured writable stream to assert approval, default rejection, and non-TTY unavailable without reading. Use a fake runner result/state to assert `approve(interruption)` then `runner.run(agent, state, ...)`, and rejection with a JSON contract rather than SDK default text.

```ts
test("non-TTY approval is unavailable without blocking", async () => {
  const handler = createTerminalApprovalHandler({
    input: Readable.from([]),
    output: new PassThrough(),
    isTTY: false,
  });
  assert.equal(await handler({ executable: "git", args: ["push"], cwd: "." }), "unavailable");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/terminal-approval-handler.test.ts tests/unit/act-approval.test.ts`

Expected: FAIL because the handler and resumption loop are missing.

- [ ] **Step 3: Implement CLI approval and SDK state loop**

Define:

```ts
export type ApprovalDecision = "approved" | "rejected" | "unavailable";
export type ApprovalHandler = (request: {
  executable: string;
  args: string[];
  cwd: string;
}) => Promise<ApprovalDecision>;
```

The terminal handler writes prompts to the injected output and accepts only `/^(y|yes)$/i`. In `runAct`, after each runner result, loop while `result.interruptions.length > 0`; parse each shell tool's JSON `arguments`, call the handler, write approval trace events, and call `state.approve` or `state.reject`. Rejection message is `JSON.stringify({ ok: false, error: createToolError(...) })`. Resume with `runner.run(agent, result.state, { maxTurns })`. Configure Runner `toolErrorFormatter` so SDK approval rejection returns the supplied JSON string unchanged.

- [ ] **Step 4: Re-run approval tests and verify GREEN**

Run: `./node_modules/.bin/tsx --test tests/unit/terminal-approval-handler.test.ts tests/unit/act-approval.test.ts`

Expected: all tests PASS; fake runner records the same state object on resume.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/agents/terminal-approval-handler.ts src/loop/stages/act.ts src/agents/create-runner.ts tests/unit/terminal-approval-handler.test.ts tests/unit/act-approval.test.ts
git commit -m "feat: approve shell calls in terminal"
```

### Task 8: Agent Composition, Configuration, Documentation, and Full Verification

**Files:**
- Create: `src/agents/tools/create-agent-tools.ts`
- Modify: `src/agents/create-agent.ts`
- Modify: `src/cli.ts`
- Modify: `config/loop.config.json`
- Modify: `README.md`
- Create: `tests/unit/agent-tools.test.ts`
- Modify: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `createAgentTools(runtime, traceWriter): Tool[]`.
- Changes: `createActorAgent(modelConfig, tools)` and CLI composition order.

- [ ] **Step 1: Write failing composition test**

```ts
test("registers file, search, and shell tools on the actor", () => {
  const tools = createAgentTools(runtime, traceWriter);
  const agent = createActorAgent(modelConfig, tools);
  assert.deepEqual(agent.tools.map((item) => item.name), [
    "workspace_file",
    "workspace_search",
    "workspace_shell",
  ]);
});
```

Also assert the checked-in JSON config parses and its approval-required rules include `npm install` and `git push` while ordinary file/search behavior remains allowed.

- [ ] **Step 2: Run composition test and verify RED**

Run: `./node_modules/.bin/tsx --test tests/unit/agent-tools.test.ts tests/unit/config.test.ts`

Expected: FAIL because tools are not composed or registered.

- [ ] **Step 3: Wire composition root and update docs**

In `runConfiguredLoop`, perform this order: disable SDK tracing → load config → create runner → create run trace writer → create runtime config → create three tools → create Agent with tools → create terminal approval handler → call loop. Pass `traceWriter` and handler through the act closure.

Update Agent instructions to tell the model that every tool returns `ToolResult`, to use `retryable` as the retry basis, and not to repeat calls requiring user action without changed conditions. Document JSON examples of success/failure, workspace hard boundary, allowed/approval-required rules, terminal `y/N`, non-TTY behavior, and trace event names in README.

- [ ] **Step 4: Run the complete offline unit suite**

Run: `npm test`

Expected: exit 0, all unit tests PASS, zero failures.

- [ ] **Step 5: Run TypeScript build**

Run: `npm run build`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 6: Inspect trace/contract requirements directly**

Run:

```bash
rg -n 'retryable|userActionRequired|suggestedNextStep|tool_failed|tool_approval_requested|tool_approval_resolved' src tests README.md
git diff --check
```

Expected: every required contract field appears in the domain type and assertions; all five tool trace events are defined/tested; `git diff --check` emits no output.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/agents/tools/create-agent-tools.ts src/agents/create-agent.ts src/cli.ts config/loop.config.json README.md tests/unit/agent-tools.test.ts tests/unit/config.test.ts
git commit -m "feat: register structured local tools"
```

## Final Review Checklist

- [ ] Re-read the approved design and map every acceptance criterion to a passing test.
- [ ] Confirm no model-visible failure path returns bare stderr or an uncaught adapter error.
- [ ] Confirm search exit code 1 is success, not `process_failed`.
- [ ] Confirm approval is evaluated only after workspace validation.
- [ ] Confirm approval applies to one tool call and cannot expand workspaceRoot.
- [ ] Confirm rejected/unavailable approvals are JSON `ToolResult` values and appear in trace.
- [ ] Confirm trace evidence excludes file write content, secrets, environment values, and unbounded output.
- [ ] Run fresh `npm test` and `npm run build` immediately before claiming completion.
