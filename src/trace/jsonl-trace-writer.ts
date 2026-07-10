import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { TraceEvent } from "./trace-event.js";

export interface TraceWriter {
  write(event: TraceEvent): Promise<void>;
}

/**
 * JSON Lines makes each event independently readable and keeps event order
 * obvious during learning/debugging. `appendFile` also leaves earlier evidence
 * intact when a later stage crashes.
 */
export class JsonlTraceWriter implements TraceWriter {
  public constructor(private readonly tracePath: string) {}

  public async write(event: TraceEvent): Promise<void> {
    await mkdir(dirname(this.tracePath), { recursive: true });

    // Do not swallow write errors. A loop whose audit trail is incomplete must
    // not report success, so callers are expected to stop when this rejects.
    await appendFile(this.tracePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
