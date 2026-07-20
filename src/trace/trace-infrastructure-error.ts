/**
 * 标记 trace 基础设施写入失败，使跨层调用方能把它与业务 step 异常区分开。
 *
 * message 沿用原始 Error，便于既有日志和断言继续定位存储故障；cause 则保留原对象，
 * 避免 wrapper 丢失错误类型、错误码或底层文件系统诊断信息。
 */
export class TraceInfrastructureError extends Error {
  public constructor(traceFailure: unknown) {
    super(
      traceFailure instanceof Error
        ? traceFailure.message
        : "Trace infrastructure write failed",
      { cause: traceFailure },
    );
    this.name = "TraceInfrastructureError";
  }
}
