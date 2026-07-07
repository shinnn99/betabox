import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  atomicWriteFile,
  quarantineCorruptQueue,
  SerializedWriter,
} from "./atomic-file";

/**
 * Payload gửi cho POST /api/agent/recording-files. Một record đại diện
 * cho một segment file — có thể là "vừa mới rolled" (opened) hoặc
 * "đã đóng" (closed).
 */
export interface SegmentReport {
  camera_id: string;
  session_id: string | null;
  file_path: string;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
}

export interface QueuedReport {
  enqueued_at: string;
  attempt: number;
  payload: SegmentReport;
}

/**
 * HIGH-19 (B4): JSONL queue cho segment report — atomic + fsync +
 * serialized writer + corrupt quarantine (không silent-drop).
 *
 * Volume: mỗi camera ~1 segment/phút, mỗi kho ~4 camera → 240 segment/giờ.
 * SerializedWriter coalesce 50ms đủ nhẹ cho nhịp này.
 */
export class SegmentReportQueue {
  private readonly writer: SerializedWriter<QueuedReport[]>;

  constructor(private readonly filePath: string) {
    this.writer = new SerializedWriter(50, async (items) => {
      const body =
        items.length === 0
          ? ""
          : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
      await atomicWriteFile(this.filePath, body);
    });
  }

  async append(report: SegmentReport): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const line: QueuedReport = {
      enqueued_at: new Date().toISOString(),
      attempt: 0,
      payload: report,
    };
    await fs.appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
  }

  async appendMany(reports: SegmentReport[]): Promise<void> {
    if (reports.length === 0) return;
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const now = new Date().toISOString();
    const body = reports
      .map((r) =>
        JSON.stringify({ enqueued_at: now, attempt: 0, payload: r } as QueuedReport),
      )
      .join("\n") + "\n";
    await fs.appendFile(this.filePath, body, "utf8");
  }

  async readAll(): Promise<QueuedReport[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const items: QueuedReport[] = [];
    let corrupt = 0;
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as QueuedReport);
      } catch {
        corrupt++;
      }
    }
    if (corrupt > 0) {
      const dest = await quarantineCorruptQueue(
        this.filePath,
        `parse_${corrupt}_lines`,
      );
      console.error(
        `[segment-queue] ${corrupt} corrupt line(s) in ${this.filePath} — file quarantined to ${dest ?? "<failed>"}`,
      );
      return items;
    }
    return items;
  }

  async rewrite(items: QueuedReport[]): Promise<void> {
    return this.writer.schedule(items);
  }

  async flushNow(): Promise<void> {
    return this.writer.flushNow();
  }
}
