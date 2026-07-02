import { promises as fs } from "node:fs";
import { dirname } from "node:path";

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
 * JSONL queue cho segment report chưa gửi được. Cùng pattern với
 * ScanQueue của Lát 1 — append lỗi, rewrite lúc retry. MVP volume
 * (mỗi camera ~1 segment/phút, mỗi kho ~4 camera → 240 segment/giờ)
 * chấp nhận được với append + rewrite.
 */
export class SegmentReportQueue {
  constructor(private readonly filePath: string) {}

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
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as QueuedReport;
        } catch {
          return null;
        }
      })
      .filter((x): x is QueuedReport => x !== null);
  }

  async rewrite(items: QueuedReport[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    if (items.length === 0) {
      await fs.writeFile(this.filePath, "", "utf8");
      return;
    }
    const body = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    await fs.writeFile(this.filePath, body, "utf8");
  }
}
