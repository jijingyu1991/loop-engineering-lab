import { setTracingDisabled } from "@openai/agents";

export type SetTracingDisabled = (disabled: boolean) => void;

/**
 * 禁用 Agents SDK 的全局 trace provider。
 *
 * `Runner({ tracingDisabled: true })` 会阻止模型级 trace 数据，但 SDK 仍可能
 * 创建全局 trace，并让默认 exporter 连接 api.openai.com。这个进程级开关会
 * 阻止该后台上传，同时不会影响项目独立维护的本地 JsonlTraceWriter。
 */
export function disableSdkTracing(
  setDisabled: SetTracingDisabled = setTracingDisabled,
): void {
  setDisabled(true);
}
