# Coding Mode and Workflow Kernel Design

## Goal

Add an explicit `coding` mode to `loop-engineering-lab` while establishing a
small workflow architecture that can later grow into a complete coding Agent
loop with context management, verification, revision, and controlled subagent
delegation.

The first milestone is intentionally read-oriented. It supports three core
tasks and one safe fallback:

- explain a module;
- find files related to a request;
- diagnose a test failure without automatically fixing it;
- inspect the repository and propose an implementation plan for requests that
  would otherwise require code changes.

Every run must emit a structured JSONL trace and finish with an explicit stop
reason.

## Command-Line Contract

The first CLI argument selects the mode. The remaining arguments form one
natural-language request:

```bash
npm run loop -- coding "帮我查看 loop 模块代码"
npm run loop -- coding "帮我实现一个 login 页面"
```

The second example does not modify files in this milestone. It inspects the
repository and returns an implementation plan.

The existing default loop invocation remains compatible:

```bash
npm run loop -- "普通任务"
```

## Architecture Decision

Use a small, mode-neutral Workflow Kernel. Implement coding behavior as
workflows and steps under a coding mode package. Do not add the three task types
directly to the existing seven-stage loop and do not build a fully generic
plugin framework in this milestone.

This boundary keeps the runtime unaware of concepts such as modules, tests, or
implementation plans while avoiding abstractions that have no current caller.

```text
CLI / Mode Router
        |
        v
Coding Request Classifier
        |
        v
Workflow Kernel -----> Structured Trace Writer
        |
        +-----> Coding Workflow Steps
        |
        +-----> Tools / Model Runtime
        |
        +-----> Explicit Stop Decision
```

## Proposed Structure

```text
src/
├── runtime/
│   ├── workflow-runner.ts
│   ├── workflow-state.ts
│   ├── workflow-step.ts
│   └── workflow-transition.ts
├── modes/
│   └── coding/
│       ├── coding-mode.ts
│       ├── coding-state.ts
│       ├── coding-task.ts
│       ├── classify-coding-task.ts
│       ├── coding-stop-reason.ts
│       ├── workflows/
│       │   ├── explain-module.ts
│       │   ├── find-related-files.ts
│       │   ├── diagnose-test-failure.ts
│       │   └── propose-implementation-plan.ts
│       └── steps/
│           ├── understand-request.ts
│           ├── inspect-context.ts
│           ├── run-diagnostic-command.ts
│           └── summarize-evidence.ts
├── context/
├── delegation/
├── verification/
├── policies/
├── tools/
└── trace/
```

Only `runtime/` and `modes/coding/` are required in the first milestone.
Existing tools and trace infrastructure should be reused instead of moved merely
to match the target directory layout. The other top-level packages describe
future ownership boundaries and are created only when their behavior is
implemented.

## Workflow Kernel

The kernel executes named steps and consumes their structured transitions. It
does not encode a fixed global sequence.

```ts
export interface WorkflowStep<State> {
  name: string;
  run(state: State): Promise<WorkflowStepResult<State>>;
}

export interface WorkflowStepResult<State> {
  state: State;
  evidence: Evidence[];
  transition:
    | { type: "next"; step: string; reason: string }
    | { type: "stop"; status: StopStatus; reason: string };
}
```

The runner must:

1. record the start and result of every step;
2. reject transitions to unknown steps;
3. enforce a maximum step count;
4. persist the stop decision before returning the final state;
5. refuse to report success if trace persistence fails.

Delegation and user-interruption transitions are intentionally deferred. They
can be added to the discriminated union without changing existing workflows.

## Request Classification

The coding classifier produces one of four stable task types:

```ts
type CodingTaskType =
  | "explain_module"
  | "find_related_files"
  | "diagnose_test_failure"
  | "propose_implementation_plan";
```

Classification should use structured model output because the input is natural
language and may be Chinese or English. The result includes the selected task
type, a normalized objective, and a short classification reason. Invalid model
output is a failed run rather than an implicit fallback.

Requests to implement or substantially modify code map to
`propose_implementation_plan` during this milestone. The classifier must not
present that fallback as completed implementation.

## Core Workflows

### Explain Module

1. Understand the requested module or concept.
2. Search for likely files and symbols.
3. Read the primary module and only the dependencies necessary to explain it.
4. Return its responsibility, public entry points, dependencies, data flow, and
   important failure boundaries.

Successful stop reason: `explanation_completed`.

### Find Related Files

1. Normalize the feature, symbol, or concept being searched.
2. Search filenames and file contents.
3. Inspect high-signal matches to remove incidental results.
4. Return grouped file paths with a reason for each relationship.

Successful stop reason: `related_files_identified`.

An empty but successfully executed search is a valid result and must be stated
explicitly. Its stop reason remains `related_files_identified` because the task
was completed and the evidence is “no related files found.”

### Diagnose Test Failure

1. Determine the narrowest safe verification command from the request and
   repository scripts.
2. Run the command through the existing permission-aware shell tool.
3. Capture exit code, sanitized stdout/stderr, and duration as evidence.
4. Search and read the failing test and relevant implementation.
5. Explain the observed failure, the evidence-supported root-cause hypothesis,
   confidence, and the next diagnostic or repair action.

This workflow does not edit files. A failing test command is expected diagnostic
evidence, not a workflow runtime failure.

Successful stop reason: `diagnosis_completed`.

### Propose Implementation Plan

1. Understand the requested change and its constraints.
2. Inspect repository conventions and related modules.
3. Identify likely files, tests, verification commands, and risks.
4. Return an ordered implementation plan and clearly state that no files were
   modified.

Successful stop reason: `implementation_plan_completed`.

## Trace Contract

Each coding run receives its own JSONL trace file. It must contain enough
information to reconstruct task classification, evidence gathering, workflow
transitions, and the terminal decision.

Required event families:

```text
coding_run_started
coding_task_classified
workflow_step_started
workflow_step_completed
workflow_step_failed
tool_started
tool_completed
tool_failed
workflow_transition_decided
coding_run_stopped
```

`coding_run_started` records the raw request, selected mode, active model, and
timestamp. `coding_task_classified` records the structured classification.
Step-completion events contain sanitized evidence summaries, not secrets or
unbounded raw command output. Existing tool events remain the authoritative
record of individual tool calls.

`coding_run_stopped` is mandatory for every run that successfully created its
trace writer. It records final status, stop reason, task type when available,
completed step count, and timestamp.

## Stop Reasons

Successful task reasons:

- `explanation_completed`;
- `related_files_identified`;
- `diagnosis_completed`;
- `implementation_plan_completed`.

Non-success reasons:

- `classification_failed`;
- `workflow_step_failed`;
- `max_workflow_steps_exceeded`;
- `tool_error`;
- `user_action_required`;
- `approval_required`;
- `approval_rejected`;
- `runtime_error`.

Stop status and stop reason remain separate. Successful task reasons map to
`completed`; permission or user-intervention reasons map to `blocked` or
`cancelled`; unrecoverable runtime and workflow errors map to `failed`.

The CLI prints status, task type, stop reason, completed step count, final
output, and trace path as structured JSON.

## Error Handling

- Classification schema failures stop with `classification_failed`.
- Unknown steps and invalid transitions stop with `workflow_step_failed` and
  retain sanitized protocol evidence in the trace.
- A tool error is interpreted by the workflow using the existing structured
  `ToolError` contract. It becomes terminal only when the workflow has no safe
  alternative.
- Diagnostic commands returning a nonzero exit code are normal evidence when
  the shell tool executed successfully.
- Trace write failures propagate immediately. A run without a trustworthy
  audit chain cannot report completion.
- No workflow may write files in the first milestone.

## Future Context Architecture

Context will be modeled as state with provenance and budget rather than as an
ever-growing prompt transcript:

```ts
interface ContextItem {
  id: string;
  kind: "request" | "file" | "symbol" | "test-output" | "git-diff" | "summary";
  content: string;
  source: string;
  relevance: number;
  tokenEstimate: number;
  freshness: "current" | "stale";
}
```

A future `ContextManager` will collect, deduplicate, rank, compact, and pack
items within a token budget. User constraints, current diffs, and active test
failures are pinned evidence. Context-selection decisions are traced.

The first milestone keeps context in typed coding state and does not implement
token compaction. Its interfaces should avoid assuming that all accumulated
content is sent to every model call.

## Future Subagent Architecture

Subagents are controlled delegation units, not independent owners of the main
workflow state. A future coordinator will create bounded tasks for roles such as
Explorer, Test Diagnostician, Implementer, and Reviewer.

```ts
interface SubagentTask {
  objective: string;
  allowedCapabilities: Array<"read" | "search" | "test" | "edit">;
  fileScope: string[];
  contextRefs: string[];
  expectedOutput: string;
  maxTurns: number;
}
```

Subagent results enter the main loop as evidence. They never directly decide
that the overall task is complete. The main workflow owns final verification
and the stop decision.

No subagent machinery is implemented in the first milestone.

## Testing Strategy

Offline unit tests must cover:

- CLI mode parsing and backward compatibility;
- all four structured classification outcomes;
- invalid classification output;
- valid and invalid workflow transitions;
- maximum workflow-step enforcement;
- the success stop reason of every workflow;
- nonzero diagnostic command exit as evidence rather than runtime failure;
- structured trace ordering and mandatory terminal event;
- trace failure propagation;
- confirmation that implementation-plan fallback performs no file writes.

Tests use injected classifier, tool, model, clock, and trace dependencies so
they remain deterministic and require no API credentials. Live classification
and task execution belong in opt-in integration tests.

Run `npm test` and `npm run build` before completion. Paid live integration is
not required unless explicitly enabled.

## Delivery Scope

This milestone delivers:

- explicit `coding` mode routing with natural-language input;
- the minimal mode-neutral Workflow Kernel;
- structured classification into four workflows;
- three read/inspect/diagnose workflows;
- one read-only implementation-planning fallback;
- task-level structured trace and explicit stop reasons;
- deterministic unit tests and CLI documentation.

It does not deliver file editing, automatic fixes, context compaction,
subagents, parallel execution, diff review, or automatic commits.

