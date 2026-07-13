import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createActorAgent } from "./agents/create-agent.js";
import { createRunner } from "./agents/create-runner.js";
import { loadLoopConfig } from "./config/load-config.js";
import type { LoopState } from "./domain/loop-state.js";
import { runLoop } from "./loop/loop-runner.js";
import { runAct } from "./loop/stages/act.js";
import { createRunTraceWriter } from "./trace/create-run-trace-writer.js";

/**
 * Compose infrastructure once, then hand the loop small dependencies. This is
 * the only place that knows about config files, environment variables and the
 * concrete Agents SDK classes.
 */
export async function runConfiguredLoop(
  task: string,
  configPath = resolve(process.cwd(), "config/loop.config.json"),
): Promise<LoopState> {
  const loaded = await loadLoopConfig(configPath, process.env);
  const runner = createRunner(loaded.modelConfig, loaded.apiKey);
  const agent = createActorAgent(loaded.modelConfig);
  const { writer: traceWriter } = await createRunTraceWriter({
    basePath: resolve(process.cwd(), loaded.config.tracePath),
    maxFiles: 20,
  });

  return runLoop({
    task,
    activeModel: loaded.activeModelName,
    maxSteps: loaded.config.safetyLimits.maxSteps,
    maxTurns: loaded.config.safetyLimits.maxTurns,
    traceWriter,
    act: ({ observation, plan, maxTurns }) =>
      runAct({ runner, agent, observation, plan, maxTurns }),
  });
}

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('Usage: npm run loop -- "your task"');
  }

  const state = await runConfiguredLoop(task);
  console.log(
    JSON.stringify(
      {
        status: state.status,
        stopReason: state.stopReason,
        completedSteps: state.steps.length,
        finalOutput: state.steps.at(-1)?.act.data?.output ?? null,
      },
      null,
      2,
    ),
  );

  if (state.status === "failed") {
    process.exitCode = 1;
  }
}

const isExecutedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Loop failed: ${message}`);
    process.exitCode = 1;
  });
}
