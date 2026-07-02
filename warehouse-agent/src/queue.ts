import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScanPayload } from "./sender";

export interface QueuedScan {
  enqueued_at: string;
  attempt: number;
  payload: ScanPayload;
}

/**
 * Append-only JSONL queue of scans that failed to reach the backend.
 * On retry the file is fully rewritten with whatever didn't succeed.
 * The MVP volume (one warehouse) makes this acceptable.
 */
export class ScanQueue {
  constructor(private readonly filePath: string) {}

  async append(scan: ScanPayload): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const line: QueuedScan = {
      enqueued_at: new Date().toISOString(),
      attempt: 0,
      payload: scan,
    };
    await fs.appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  async readAll(): Promise<QueuedScan[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const item = JSON.parse(line) as QueuedScan;
          // Backfill agent_event_id for entries enqueued by older agent
          // builds (pre-idempotency). A fresh UUID is fine because these
          // events have never reached the backend.
          if (item.payload && !item.payload.agent_event_id) {
            item.payload.agent_event_id = randomUUID();
          }
          return item;
        } catch {
          return null;
        }
      })
      .filter((x): x is QueuedScan => x !== null);
  }

  async rewrite(items: QueuedScan[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    if (items.length === 0) {
      await fs.writeFile(this.filePath, "", "utf8");
      return;
    }
    const body = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    await fs.writeFile(this.filePath, body, "utf8");
  }
}
