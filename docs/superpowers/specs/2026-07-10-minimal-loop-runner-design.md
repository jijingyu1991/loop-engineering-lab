# Minimal Loop Runner Design

## Goal

Build a minimal TypeScript loop runner that accepts a task, creates loop state, executes ordered loop steps, writes a JSONL trace, and stops for an explicit reason. The first implementation prioritizes a complete and extensible loop skeleton over sophisticated planning or reviewing.

The runnable checkpoint is a three-iteration loop whose trace shows every stage in order and the final stop reason. The `act` stage uses a real model API through the OpenAI Agents SDK. GPT and DeepSeek are selected by changing a logical model name in a configuration file.

## Scope

The first version includes:

- TypeScript and Node.js.
- OpenAI Agents SDK for the `act` stage.
- GPT and DeepSeek model configuration.
- A fixed seven-stage loop step: `observe`, `orient`, `plan`, `act`, `verify`, `reflect`, `stop`.
- Skeleton implementations for `orient`, `plan`, `verify`, and `reflect`.
- Runtime implementations for `observe` and `stop`.
- A real Agent API call for `act`.
- Plan-produced business stop criteria.
- Configuration safety limits for maximum loop steps and maximum Agent turns.
- Append-only JSONL tracing.
- Unit tests for pure loop behavior and a live API integration checkpoint.

The first version excludes:

- Planner, reviewer, or other multi-agent workflows.
- Handoffs, retries, and automatic replanning.
- Production tool implementations and guardrails.
- Database or remote trace storage.
- Dynamic stage ordering.

## Configuration

`config/loop.config.json` selects a model through `activeModel`. Application code does not contain provider-selection branches outside the provider factory.

```json
{
  "activeModel": "gpt",
  "models": {
    "gpt": {
      "model": "gpt-5.4-mini",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "api": "responses"
    },
    "deepseek": {
      "model": "deepseek-v4-flash",
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "api": "chat_completions"
    }
  },
  "safetyLimits": {
    "maxSteps": 3,
    "maxTurns": 5
  },
  "tracePath": "traces/loop.jsonl"
}
```

Changing `activeModel` from `gpt` to `deepseek` switches the active provider definition. Both providers explicitly configure `baseURL`. GPT uses the Responses API; DeepSeek uses its OpenAI-compatible Chat Completions API.

`.env` contains the real keys and is ignored by Git. `.env.example` contains empty placeholders:

```dotenv
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

The application validates the selected model definition and the corresponding environment variable before calling an API. It never writes API keys to logs or traces.

## Domain Model

One outer loop iteration is a `LoopStep`. Every `LoopStep` contains the same ordered stages.

```ts
type LoopStage =
  | "observe"
  | "orient"
  | "plan"
  | "act"
  | "verify"
  | "reflect"
  | "stop";

type StageSource = "runtime" | "agent" | "skeleton";

interface StageResult<T> {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  source: StageSource;
  data: T | null;
  error: StepError | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface LoopStep {
  index: number;
  status: "running" | "completed" | "failed";
  observe: StageResult<ObserveData>;
  orient: StageResult<OrientData>;
  plan: StageResult<PlanData>;
  act: StageResult<ActData>;
  verify: StageResult<VerifyData>;
  reflect: StageResult<ReflectData>;
  stop: StageResult<StopDecision>;
  startedAt: string;
  completedAt: string | null;
}
```

The loop state owns all completed and current steps:

```ts
interface LoopState {
  task: string;
  activeModel: string;
  status: "running" | "completed" | "failed";
  steps: LoopStep[];
  stopReason: StopReason | null;
  startedAt: string;
  stoppedAt: string | null;
}
```

## Stage Responsibilities

### Observe

`observe` is a runtime stage. It creates a snapshot from the original task and the previous step's action and reflection. It does not call a model.

### Orient

`orient` expresses the current objective and constraints. The first version returns deterministic skeleton data and marks the result with `source: "skeleton"`.

### Plan

`plan` produces both the next action and a business completion criterion:

```ts
interface PlanData {
  nextAction: string;
  stopCondition: {
    description: string;
  };
}
```

The first version returns deterministic skeleton data whose business condition is to complete three iterations. This makes the checkpoint exercise the full loop three times while preserving the rule that the plan owns the business stop condition. A later planner Agent can replace the internals without changing the stage contract or loop runner.

### Act

`act` is the only Agent-backed stage in the first version. It builds an Agent from the selected model configuration and calls `runner.run()` with the configured `maxTurns`. It records the final text output as `ActData`.

### Verify

`verify` evaluates whether the action satisfies the business stop condition produced by `plan`:

```ts
interface VerifyData {
  passed: boolean;
  evidence: string;
}
```

The first version uses an explicit skeleton implementation. It reports `passed: false` for iterations one and two and `passed: true` for iteration three, with evidence that cites the plan's three-iteration condition. It is not presented as an independent reviewer. A later reviewer Agent can replace the implementation while preserving the contract.

### Reflect

`reflect` summarizes the iteration and supplies focus for the next observation. The first version uses skeleton data derived from the action result.

### Stop

`stop` is a runtime decision stage. It does not invent the business completion criterion; `plan` owns that responsibility. It combines the verification result with hard safety limits and execution failures.

Stop priority is:

1. Agent `maxTurns` exceeded: fail with `max_turns_exceeded`.
2. Configuration, API, trace, or stage execution error: fail with `step_error`.
3. `verify.passed` is true: complete with `plan_condition_met`.
4. `maxSteps` is reached before the plan condition passes: fail with `max_steps_exceeded`.
5. Otherwise continue to the next `LoopStep`.

`maxSteps` and `maxTurns` are safety limits, not business success criteria.

## Execution Flow

The CLI accepts a non-empty task, loads configuration, validates the selected API key, creates the model provider and Agent runner, initializes state, and starts the loop.

For each iteration, `run-loop-step.ts`:

1. Creates a new `LoopStep`.
2. Runs stages in the fixed order `observe`, `orient`, `plan`, `act`, `verify`, `reflect`, `stop`.
3. Writes a trace event after every stage transition.
4. Returns the updated step and stop decision to `loop-runner.ts`.

The runner either creates the next step or finalizes the state and writes `loop_stopped`. If `act` fails, later business stages are marked `skipped`, but `stop` still runs so the failure has a structured stop decision.

The first version performs one real model call per outer step. A three-step run therefore makes three Agent calls unless it stops earlier or an Agent call consumes multiple internal turns.

## Trace Format

The JSONL trace is append-only. Events contain timestamps, loop-step indexes, stage names, stage status, result source, and sanitized data.

Representative events are:

- `loop_started`
- `stage_started`
- `stage_completed`
- `stage_failed`
- `stage_skipped`
- `loop_stopped`

The final event includes `status`, `stopReason`, and `completedSteps`. API keys, authorization headers, and raw credential-bearing request objects are never included.

## Error Handling

- Missing or invalid configuration fails before API execution.
- An unknown `activeModel` fails with the missing logical name.
- A missing selected-provider API key names the required environment variable without exposing its value.
- An empty Agent output fails the `act` stage.
- An Agents SDK maximum-turn error becomes `max_turns_exceeded`.
- Other Agent or stage errors become `step_error`.
- A trace-write failure stops the loop because a run without its audit trail is not considered successful.
- The CLI returns a nonzero exit code for failed loops.

## Project Structure

```text
loop-engineering-lab/
├── config/
│   └── loop.config.json
├── src/
│   ├── cli.ts
│   ├── config/
│   │   ├── config-schema.ts
│   │   └── load-config.ts
│   ├── domain/
│   │   ├── loop-state.ts
│   │   ├── loop-step.ts
│   │   └── stage-result.ts
│   ├── agents/
│   │   ├── create-agent.ts
│   │   ├── create-runner.ts
│   │   ├── providers/
│   │   │   └── create-model-provider.ts
│   │   ├── tools/
│   │   │   ├── tool-registry.ts
│   │   │   └── implementations/
│   │   └── guardrails/
│   │       ├── input/
│   │       └── output/
│   ├── loop/
│   │   ├── create-loop-state.ts
│   │   ├── loop-runner.ts
│   │   ├── run-loop-step.ts
│   │   └── stages/
│   │       ├── observe.ts
│   │       ├── orient.ts
│   │       ├── plan.ts
│   │       ├── act.ts
│   │       ├── verify.ts
│   │       ├── reflect.ts
│   │       └── stop.ts
│   └── trace/
│       ├── trace-event.ts
│       └── jsonl-trace-writer.ts
├── tests/
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── loop-step.test.ts
│   │   ├── stop.test.ts
│   │   └── trace-writer.test.ts
│   └── integration/
│       └── live-loop.test.ts
├── traces/
│   └── .gitkeep
├── .env
├── .env.example
├── package.json
└── tsconfig.json
```

`tools/` and `guardrails/` are architectural extension points. The first implementation does not add placeholder production tools or guardrails. Directories and registries should be created only when an implementation needs them.

Future specialized Agents can be grouped under `agents/planner/`, `agents/actor/`, and `agents/reviewer/`. Tools and guardrails remain shared Agent capabilities rather than Loop-stage implementations. `loop/stages/act.ts` consumes an assembled Agent and does not define tools or guardrails itself.

## Testing and Acceptance

Unit tests cover pure behavior without network access:

- Configuration lookup by logical model name.
- State and step creation.
- Fixed seven-stage ordering.
- Plan-produced stop-condition propagation into verify and stop.
- Stop priority and reason mapping.
- JSONL trace order and final stop reason.

The live integration checkpoint uses a real API key and does not mock the `act` stage:

1. Generate `.env` and configuration files.
2. Pause for the user to fill the selected provider's API key.
3. Run a three-step task through the configured GPT or DeepSeek model.
4. Confirm three real `act` calls unless an earlier failure occurs.
5. Confirm every step traces the seven stages in order.
6. Confirm the third iteration satisfies the skeleton plan condition and the final trace records `plan_condition_met`.

With the default values, the plan condition and `maxSteps` boundary are both reached on iteration three. The plan-condition success check has higher priority, so the checkpoint completes successfully. `maxSteps` remains the failure fallback when a future plan condition is not satisfied in time.

If both API keys are supplied, the checkpoint can run once with each `activeModel` value. Otherwise, the selected provider is the live acceptance target and configuration tests cover model-name switching.

## Documentation Sources

- OpenAI Agents SDK TypeScript quickstart: <https://openai.github.io/openai-agents-js/guides/quickstart/>
- OpenAI Agents SDK model providers: <https://openai.github.io/openai-agents-js/guides/models/>
- OpenAI Agents SDK runner behavior: <https://openai.github.io/openai-agents-js/guides/running-agents/>
- DeepSeek OpenAI-compatible API quickstart: <https://api-docs.deepseek.com/>
