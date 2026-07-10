# Minimal Loop Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a documented TypeScript loop skeleton that executes seven ordered stages, calls GPT or DeepSeek in `act`, writes JSONL trace events, and stops with a structured reason.

**Architecture:** `loop-runner.ts` owns iteration while `run-loop-step.ts` owns the fixed stage order. Stage functions exchange typed domain data; the Agent boundary owns provider-specific configuration; the trace writer owns durable JSONL output. Skeleton planning and verification keep the first version deterministic while `act` remains a real Agents SDK call.

**Tech Stack:** TypeScript, Node.js, `@openai/agents`, Zod 4, dotenv, tsx, Node test runner.

## Global Constraints

- Keep the implementation in TypeScript and prefer small, focused files.
- Add detailed learning-oriented comments around architecture, data flow, state transitions, provider selection, and error classification.
- Do not log API keys, authorization headers, or credential-bearing request objects.
- Select GPT or DeepSeek only through `activeModel` in `config/loop.config.json`.
- Run stages in this exact order: `observe`, `orient`, `plan`, `act`, `verify`, `reflect`, `stop`.
- Use skeleton implementations for `orient`, `plan`, `verify`, and `reflect`; use a real Agents SDK call for `act`.
- Treat `maxSteps` and `maxTurns` as safety limits, not business success criteria.
- Do not add planner/reviewer Agents, tools, guardrails, retries, databases, or dynamic stage ordering.

---

## File Map

- `package.json`, `tsconfig.json`: Node/TypeScript build, test, and CLI commands.
- `config/loop.config.json`, `.env.example`, `.env`: model selection, safety limits, and local credentials.
- `src/config/*`: validate JSON configuration and selected API-key environment variables.
- `src/domain/*`: shared loop, stage, and stop-decision types.
- `src/agents/*`: translate model configuration into Agents SDK provider, runner, and Agent instances.
- `src/loop/stages/*`: implement the seven stage contracts.
- `src/loop/run-loop-step.ts`: run one complete seven-stage iteration.
- `src/loop/loop-runner.ts`: repeat iterations until stop says complete or fail.
- `src/trace/*`: define trace events and append them as JSONL.
- `src/cli.ts`: parse task input and compose the application.
- `tests/unit/*`: pure configuration, pipeline, stop, and trace behavior.
- `tests/integration/live-loop.test.ts`: opt-in real API checkpoint.

---

### Task 1: Project Tooling and Validated Configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `config/loop.config.json`
- Create: `.env.example`
- Create: `.env`
- Modify: `.gitignore`
- Create: `src/config/config-schema.ts`
- Create: `src/config/load-config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `LoopConfig`, `ModelConfig`, `parseLoopConfig(raw)`, and `loadLoopConfig(path, env)`.
- `loadLoopConfig` returns `{ config, activeModel, apiKey }` with the selected key resolved but never logged.

- [ ] **Step 1: Add the failing configuration tests**

```ts
test("selects a model by the activeModel logical name", () => {
  const parsed = parseLoopConfig(validConfig);
  assert.equal(parsed.models[parsed.activeModel].model, "gpt-5.4-mini");
});

test("rejects an unknown activeModel", () => {
  assert.throws(() => parseLoopConfig({ ...validConfig, activeModel: "missing" }));
});

test("requires only the selected model API key", async () => {
  const loaded = await loadLoopConfig(configPath, { OPENAI_API_KEY: "test-key" });
  assert.equal(loaded.apiKey, "test-key");
});
```

- [ ] **Step 2: Run the test and verify red**

Run: `npm test -- tests/unit/config.test.ts`
Expected: FAIL because the project and configuration modules do not exist.

- [ ] **Step 3: Add tooling and configuration implementation**

Use Zod discriminated configuration data:

```ts
const modelConfigSchema = z.object({
  model: z.string().min(1),
  baseURL: z.string().url(),
  apiKeyEnv: z.string().min(1),
  api: z.enum(["responses", "chat_completions"]),
});

export const loopConfigSchema = z
  .object({
    activeModel: z.string().min(1),
    models: z.record(z.string(), modelConfigSchema),
    safetyLimits: z.object({
      maxSteps: z.number().int().positive(),
      maxTurns: z.number().int().positive(),
    }),
    tracePath: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (!value.models[value.activeModel]) {
      context.addIssue({ code: "custom", path: ["activeModel"], message: `Unknown activeModel: ${value.activeModel}` });
    }
  });
```

`loadLoopConfig` reads JSON, validates it, selects the logical model, and resolves `apiKeyEnv`. Add comments explaining why the credential is returned separately from serializable configuration.

- [ ] **Step 4: Run configuration tests and build**

Run: `npm test -- tests/unit/config.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: TypeScript compilation succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json config/loop.config.json .env.example .gitignore src/config tests/unit/config.test.ts
git commit -m "feat: add validated loop configuration"
```

---

### Task 2: Domain Types and Ordered Stage Skeleton

**Files:**
- Create: `src/domain/stage-result.ts`
- Create: `src/domain/loop-step.ts`
- Create: `src/domain/loop-state.ts`
- Create: `src/domain/stop-decision.ts`
- Create: `src/loop/create-loop-state.ts`
- Create: `src/loop/stages/observe.ts`
- Create: `src/loop/stages/orient.ts`
- Create: `src/loop/stages/plan.ts`
- Create: `src/loop/stages/verify.ts`
- Create: `src/loop/stages/reflect.ts`
- Test: `tests/unit/loop-step.test.ts`

**Interfaces:**
- Produces: `LoopState`, `LoopStep`, `StageResult<T>`, `PlanData`, `VerifyData`, and `createLoopState(task, activeModel)`.
- Skeleton plan produces a three-iteration business condition; skeleton verify passes only at step three.

- [ ] **Step 1: Add failing domain and skeleton tests**

```ts
test("creates an empty running state", () => {
  const state = createLoopState("improve this answer", "gpt", now);
  assert.equal(state.status, "running");
  assert.deepEqual(state.steps, []);
});

test("skeleton plan owns the three-iteration stop condition", async () => {
  const plan = await runPlan({ stepIndex: 1 });
  assert.match(plan.stopCondition.description, /three iterations/i);
});

test("skeleton verification passes only on iteration three", async () => {
  assert.equal((await runVerify({ stepIndex: 2, plan })).passed, false);
  assert.equal((await runVerify({ stepIndex: 3, plan })).passed, true);
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npm test -- tests/unit/loop-step.test.ts`
Expected: FAIL because the domain and stage modules do not exist.

- [ ] **Step 3: Implement typed stages and state factories**

Use one generic lifecycle wrapper:

```ts
export interface StageResult<T> {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  source: "runtime" | "agent" | "skeleton";
  data: T | null;
  error: StepError | null;
  startedAt: string | null;
  completedAt: string | null;
}
```

Add detailed comments explaining why data and lifecycle metadata live together and why skeleton results are explicitly labeled. Keep stage functions pure where possible.

- [ ] **Step 4: Run domain tests and build**

Run: `npm test -- tests/unit/loop-step.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/loop/create-loop-state.ts src/loop/stages tests/unit/loop-step.test.ts
git commit -m "feat: add typed loop stage skeleton"
```

---

### Task 3: Agent Provider and Real Act Stage

**Files:**
- Create: `src/agents/providers/create-model-provider.ts`
- Create: `src/agents/create-runner.ts`
- Create: `src/agents/create-agent.ts`
- Create: `src/loop/stages/act.ts`
- Test: `tests/unit/agent-provider.test.ts`

**Interfaces:**
- Consumes: selected `ModelConfig`, resolved API key, and `maxTurns`.
- Produces: `createModelProvider`, `createRunner`, `createActorAgent`, and `runAct`.
- `runAct` returns non-empty `{ output: string }` or throws a classified error.

- [ ] **Step 1: Add failing provider-selection tests**

```ts
test("maps responses config to a Responses provider", () => {
  const options = toProviderOptions(gptConfig, "key");
  assert.equal(options.useResponses, true);
  assert.equal(options.baseURL, "https://api.openai.com/v1");
});

test("maps DeepSeek config to Chat Completions", () => {
  const options = toProviderOptions(deepSeekConfig, "key");
  assert.equal(options.useResponses, false);
  assert.equal(options.baseURL, "https://api.deepseek.com");
});
```

- [ ] **Step 2: Run provider tests and verify red**

Run: `npm test -- tests/unit/agent-provider.test.ts`
Expected: FAIL because provider modules do not exist.

- [ ] **Step 3: Implement the Agents SDK boundary**

```ts
export function toProviderOptions(model: ModelConfig, apiKey: string) {
  return {
    apiKey,
    baseURL: model.baseURL,
    useResponses: model.api === "responses",
  };
}

export function createModelProvider(model: ModelConfig, apiKey: string) {
  return new OpenAIProvider(toProviderOptions(model, apiKey));
}
```

Create an `Agent` with a learning-project instruction and pass its string model name. `runAct` calls `runner.run(agent, prompt, { maxTurns })`, validates `finalOutput`, and comments on the distinction between outer loop steps and internal Agent turns.

- [ ] **Step 4: Run provider tests and build**

Run: `npm test -- tests/unit/agent-provider.test.ts`
Expected: PASS without making a network request.

Run: `npm run build`
Expected: PASS against installed Agents SDK types.

- [ ] **Step 5: Commit**

```bash
git add src/agents src/loop/stages/act.ts tests/unit/agent-provider.test.ts
git commit -m "feat: add configurable agent act stage"
```

---

### Task 4: Stop Stage and JSONL Trace Writer

**Files:**
- Create: `src/loop/stages/stop.ts`
- Create: `src/trace/trace-event.ts`
- Create: `src/trace/jsonl-trace-writer.ts`
- Test: `tests/unit/stop.test.ts`
- Test: `tests/unit/trace-writer.test.ts`

**Interfaces:**
- Produces: `decideStop(input): StopDecision` and `JsonlTraceWriter.write(event): Promise<void>`.
- Stop order is max-turn failure, execution failure, plan-condition success, max-step failure, continue.

- [ ] **Step 1: Add failing stop-priority and trace tests**

```ts
test("plan completion wins at the maxSteps boundary", () => {
  assert.deepEqual(decideStop({ stepIndex: 3, maxSteps: 3, verificationPassed: true }), {
    shouldStop: true,
    status: "completed",
    reason: "plan_condition_met",
  });
});

test("maxSteps fails when the plan condition is unmet", () => {
  assert.equal(decideStop({ stepIndex: 3, maxSteps: 3, verificationPassed: false }).reason, "max_steps_exceeded");
});

test("writes one JSON object per line in order", async () => {
  await writer.write(started);
  await writer.write(stopped);
  assert.deepEqual(await readEvents(path), [started, stopped]);
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `npm test -- tests/unit/stop.test.ts tests/unit/trace-writer.test.ts`
Expected: FAIL because stop and trace modules do not exist.

- [ ] **Step 3: Implement stop priority and append-only tracing**

Use `mkdir(..., { recursive: true })` before `appendFile`. Serialize with `JSON.stringify(event) + "\n"`. Add comments explaining why a write failure is allowed to reject rather than being swallowed.

- [ ] **Step 4: Run stop/trace tests and build**

Run: `npm test -- tests/unit/stop.test.ts tests/unit/trace-writer.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop/stages/stop.ts src/trace tests/unit/stop.test.ts tests/unit/trace-writer.test.ts
git commit -m "feat: add stop decisions and jsonl tracing"
```

---

### Task 5: Loop-Step Orchestration, Runner, and CLI

**Files:**
- Create: `src/loop/run-loop-step.ts`
- Create: `src/loop/loop-runner.ts`
- Create: `src/cli.ts`
- Test: `tests/unit/loop-runner.test.ts`

**Interfaces:**
- Consumes: stage functions, `JsonlTraceWriter`, active Agent runner, and validated config.
- Produces: `runLoopStep(context)` and `runLoop(options): Promise<LoopState>`.

- [ ] **Step 1: Add a failing three-step orchestration test**

```ts
test("runs seven stages in order for three iterations", async () => {
  const result = await runLoop({ task, dependencies: deterministicDependencies });
  assert.equal(result.steps.length, 3);
  assert.deepEqual(stageNames(trace), [
    "observe", "orient", "plan", "act", "verify", "reflect", "stop",
    "observe", "orient", "plan", "act", "verify", "reflect", "stop",
    "observe", "orient", "plan", "act", "verify", "reflect", "stop",
  ]);
  assert.equal(result.stopReason, "plan_condition_met");
});
```

The test injects a deterministic `act` function to exercise orchestration without network access. This is a loop unit test; live acceptance still uses the real Agent implementation.

- [ ] **Step 2: Run the orchestration test and verify red**

Run: `npm test -- tests/unit/loop-runner.test.ts`
Expected: FAIL because orchestration modules do not exist.

- [ ] **Step 3: Implement the loop and CLI composition root**

`run-loop-step.ts` runs every normal stage sequentially. On `act` failure it marks verify and reflect skipped, then still executes stop with the classified error. `loop-runner.ts` writes `loop_started`, stage events, and `loop_stopped`. `cli.ts` composes concrete dependencies and maps failed state to `process.exitCode = 1`.

Add detailed comments at the orchestration boundaries, especially where mutable state is intentionally centralized and where stop decisions are copied onto final state.

- [ ] **Step 4: Run all unit tests and build**

Run: `npm test`
Expected: all unit tests PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop/run-loop-step.ts src/loop/loop-runner.ts src/cli.ts tests/unit/loop-runner.test.ts
git commit -m "feat: orchestrate traced loop execution"
```

---

### Task 6: Live API Checkpoint and Learning Documentation

**Files:**
- Create: `tests/integration/live-loop.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `.env`, `config/loop.config.json`, and the public `runLoop` composition.
- Produces: documented setup and an opt-in real API verification command.

- [ ] **Step 1: Add the opt-in integration test**

```ts
test("runs a live three-step loop", { skip: process.env.RUN_LIVE_LOOP !== "1" }, async () => {
  const state = await runConfiguredLoop("Improve this concise task description over three iterations.");
  assert.equal(state.steps.length, 3);
  assert.equal(state.stopReason, "plan_condition_met");
  assert.ok(state.steps.every((step) => step.act.source === "agent"));
});
```

- [ ] **Step 2: Document commands and trace interpretation**

README must explain:

- Install with `npm install`.
- Fill `.env` without committing it.
- Switch `activeModel` in JSON.
- Run `npm run loop -- "task"`.
- Run unit tests with `npm test`.
- Run the real integration checkpoint with `RUN_LIVE_LOOP=1 npm run test:integration`.
- Read stage order and stop reason in the JSONL trace.
- Understand `maxSteps` versus Agents SDK `maxTurns`.

- [ ] **Step 3: Verify without credentials**

Run: `npm test`
Expected: all unit tests PASS and no network calls occur.

Run: `npm run build`
Expected: PASS.

Run: `npm run test:integration`
Expected: the live test is SKIPPED unless `RUN_LIVE_LOOP=1`.

- [ ] **Step 4: Pause for credential entry, then run live acceptance**

Ask the user to fill the selected key in `.env`. After confirmation, run:

```bash
RUN_LIVE_LOOP=1 npm run test:integration
```

Expected: PASS, three `act` calls, seven ordered stage results per iteration, and final `plan_condition_met`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/live-loop.test.ts README.md
git commit -m "docs: add live loop checkpoint"
```

---

## Final Verification

- [ ] Run `npm test` and confirm all unit tests pass.
- [ ] Run `npm run build` and confirm TypeScript compiles.
- [ ] Run `npm run test:integration` without the opt-in flag and confirm it skips safely.
- [ ] Confirm `.env` is ignored with `git check-ignore .env`.
- [ ] Confirm no key-like values are tracked with `git grep -n "sk-" -- ':!package-lock.json'`.
- [ ] After the user fills `.env`, run the live integration checkpoint and inspect `traces/loop.jsonl` for stage order and `plan_condition_met`.
