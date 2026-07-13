import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { TraceEvent } from "./trace-event.js";

export interface TraceWriter {
  write(event: TraceEvent): Promise<void>;
}

/**
 * JSON Lines 让每个事件都能独立读取，也便于学习和调试时观察事件顺序。
 * 使用 `appendFile` 还能保证后续阶段崩溃时，之前已经写入的审计证据仍然保留。
 */
export class JsonlTraceWriter implements TraceWriter {
  public constructor(private readonly tracePath: string) {}

  public async write(event: TraceEvent): Promise<void> {
    await mkdir(dirname(this.tracePath), { recursive: true });

    // 不吞掉写入错误：审计轨迹不完整的 loop 不能报告成功。因此本 Promise
    // 拒绝时，调用方应停止执行，并让失败进入统一的错误处理流程。
    await appendFile(this.tracePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
