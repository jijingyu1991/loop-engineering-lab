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
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly downstream: TraceWriter) {}

  public write(event: TraceEvent): Promise<void> {
    // downstream write 与内存 push 必须位于同一个串行临界区。否则两个重叠调用可能
    // 先按调用顺序落盘、却按完成顺序进入 snapshot，使 reviewer 的 trace index 无法
    // 回指 JSONL。每个调用返回自己的 operation，因此调用方仍能观察该次真实失败。
    const operation = this.writeQueue.then(async () => {
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
    });

    // 队列尾部只承担“下一次何时可以开始”的调度职责。吞掉尾部 rejection 不会改变
    // operation 对当前调用方的拒绝，却能防止一次存储故障永久毒化所有后续写入。
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  public snapshot(): readonly TraceEvent[] {
    // 每次复制数组而非返回内部容器。readonly 仅限制 TypeScript 类型，副本还能
    // 防止 JavaScript 调用方通过 push、splice 等操作篡改 writer 维护的事件顺序。
    return [...this.events];
  }
}
