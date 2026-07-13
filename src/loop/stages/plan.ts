import type { PlanData } from "../../domain/loop-step.js";

export interface PlanInput {
  stepIndex: number;
  objective: string;
}

/**
 * plan 阶段负责定义业务停止条件。固定执行三轮只是学习项目的骨架数据，不是
 * 隐藏在 runner 内部的安全规则；因此以后替换 planner 时可以显式改变该条件。
 */
export async function runPlan(input: PlanInput): Promise<PlanData> {
  return {
    nextAction: `Execute iteration ${input.stepIndex} for: ${input.objective}`,
    stopCondition: {
      description: "Complete three iterations of the task.",
    },
  };
}
