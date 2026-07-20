import {
  subagentContractSchema,
  validateSubagentResult,
  type SubagentContract,
  type SubagentResult,
} from "../domain/subagent-contract.js";
import type { TraceWriter } from "../trace/jsonl-trace-writer.js";
import {
  SubagentMaxStepsExceededError,
  type SubagentInvoker,
} from "./subagent-invoker.js";

class SubagentTimeoutError extends Error {
  public constructor() {
    super("Subagent invocation timed out");
    this.name = "SubagentTimeoutError";
  }
}

function createFailure(
  contract: SubagentContract,
  status: "failed" | "timed_out",
  code: string,
  message: string,
): SubagentResult {
  return validateSubagentResult(contract, {
    contractId: contract.id,
    role: contract.role,
    status,
    summary: message,
    evidence: [],
    errors: [{ code, message, retryable: false }],
  });
}

function compilePrompt(contract: SubagentContract): string {
  return [
    `Contract ID: ${contract.id}`,
    `Role: ${contract.role}`,
    `Task: ${contract.task}`,
    `Constraints:\n${contract.scope.constraints.join("\n")}`,
    `Expected output:\n${contract.expectedOutput.requirements.join("\n")}`,
    ...contract.contextPackage.items.map((item) =>
      `Context item ${item.id} (${item.kind}, source=${item.source}):\n${item.content}`),
  ].join("\n\n");
}

export async function runSubagent(input: {
  contract: unknown;
  invoker: SubagentInvoker;
  traceWriter: TraceWriter;
  validateCompletedResult?: (
    contract: SubagentContract,
    result: SubagentResult,
  ) => SubagentResult;
  now?: () => string;
}): Promise<SubagentResult> {
  // Contract 是授权和预算的唯一来源；在写 started trace 之前完整解析，避免为一个
  // 无效任务留下“已经启动”的误导性审计事件，也避免把未验证的能力交给 provider。
  const contract = subagentContractSchema.parse(input.contract);
  const now = input.now ?? (() => new Date().toISOString());

  await input.traceWriter.write({
    event: "subagent_started",
    timestamp: now(),
    contractId: contract.id,
    role: contract.role,
    contextItemIds: contract.contextPackage.items.map((item) => item.id),
    allowedTools: [...contract.allowedTools],
    limits: { ...contract.limits },
  });

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finalResult: SubagentResult | undefined;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        // 先拒绝 timeout 分支，再发出 abort。某些 invoker 会在 abort listener 中立即
        // resolve；这个顺序确保达到预算边界后仍由 timeout 获胜，而不是误报成功。
        reject(new SubagentTimeoutError());
        controller.abort();
      }, contract.limits.timeoutMs);
    });

    // AbortSignal 只是合作式取消提示，provider 可能忽略它。因此必须由本地 timer
    // 参与 Promise.race，保证 runSubagent 自身在 timeoutMs 后一定结束等待。
    const rawResult = await Promise.race([
      input.invoker({
        prompt: compilePrompt(contract),
        allowedTools: [...contract.allowedTools],
        maxSteps: contract.limits.maxSteps,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    try {
      const validated = validateSubagentResult(contract, rawResult);
      finalResult = validated.status === "completed"
        && input.validateCompletedResult !== undefined
        ? input.validateCompletedResult(contract, validated)
        : validated;
    } catch {
      // 模型输出和角色专属 completed 协议都属于不可信边界。只返回稳定错误码，
      // 不把 Zod path、provider 原文或潜在上下文内容泄漏到 summary/trace。
      finalResult = createFailure(
        contract,
        "failed",
        "subagent_invalid_result",
        "Subagent returned an invalid result.",
      );
    }
  } catch (error) {
    if (error instanceof SubagentTimeoutError) {
      finalResult = createFailure(
        contract,
        "timed_out",
        "subagent_timeout",
        "Subagent invocation timed out.",
      );
    } else if (error instanceof SubagentMaxStepsExceededError) {
      finalResult = createFailure(
        contract,
        "failed",
        "subagent_max_steps_exceeded",
        "Subagent exceeded maxSteps.",
      );
    } else {
      // invocation exception 可能含 SDK 请求、凭据或 provider 响应细节；通用运行时
      // 只暴露可路由的安全错误，原始异常不进入 lifecycle trace。
      finalResult = createFailure(
        contract,
        "failed",
        "subagent_invocation_failed",
        "Subagent invocation failed.",
      );
    }
  } finally {
    // success、校验失败、provider 异常和 timeout 都经过这里，防止已 settle 的运行仍
    // 留下 timer，造成额外 abort、测试进程滞留或长期运行中的资源泄漏。
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  // 两次 trace 写入都位于 invocation 错误归一化之外。审计存储失败必须原样 reject，
  // 不能被伪装成可恢复的 subagent 结果，否则调用方会误以为生命周期记录完整。
  await input.traceWriter.write({
    event: "subagent_finished",
    timestamp: now(),
    result: finalResult,
  });
  return finalResult;
}
