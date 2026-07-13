import { setTracingDisabled } from "@openai/agents";

export type SetTracingDisabled = (disabled: boolean) => void;

/**
 * Disable the Agents SDK global trace provider.
 *
 * `Runner({ tracingDisabled: true })` prevents model-level trace data, but the
 * SDK can still create a global trace and let its default exporter contact
 * api.openai.com. This process-wide switch prevents that background upload.
 * It does not affect our independent local JsonlTraceWriter.
 */
export function disableSdkTracing(
  setDisabled: SetTracingDisabled = setTracingDisabled,
): void {
  setDisabled(true);
}
