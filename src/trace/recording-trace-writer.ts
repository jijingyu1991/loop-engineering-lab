import type { TraceEvent } from "./trace-event.js";
import type { TraceWriter } from "./jsonl-trace-writer.js";
import { TraceInfrastructureError } from "./trace-infrastructure-error.js";

/**
 * 为下游 TraceWriter 增加可读取的内存事件快照。
 *
 * 这个 decorator 是持久化边界：后续消费者只能看到已由下游 writer 成功接受的
 * 事件，从而保证 snapshot 的每个下标都对应一条真实的 JSONL 审计记录。
 */
export class RecordingTraceWriter implements TraceWriter {
  private readonly events: TraceEvent[] = [];

  public constructor(private readonly downstream: TraceWriter) {}

  public async write(event: TraceEvent): Promise<void> {
    // 先委托持久化；下游失败时 await 会拒绝，push 不会执行，避免内存快照
    // 暴露一条实际没有落盘的事件。专用 error 只标记基础设施来源并保留 cause，
    // 让 workflow 即使在 step.run 内收到失败，也不会把它归一化成业务 step 错误。
    try {
      await this.downstream.write(event);
    } catch (error) {
      // decorator 可能被组合多次；已标记的错误保持同一实例，避免 cause 链重复嵌套。
      if (error instanceof TraceInfrastructureError) {
        throw error;
      }
      throw new TraceInfrastructureError(error);
    }
    this.events.push(event);
  }

  public snapshot(): readonly TraceEvent[] {
    // 每次复制数组而非返回内部容器。readonly 仅限制 TypeScript 类型，副本还能
    // 防止 JavaScript 调用方通过 push、splice 等操作篡改 writer 维护的事件顺序。
    return [...this.events];
  }
}
