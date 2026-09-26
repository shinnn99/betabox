import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScanPayload } from "./sender";
import {
  atomicWriteFile,
  quarantineCorruptQueue,
  SerializedWriter,
} from "./atomic-file";
import { AsyncMutex } from "./queue-lock";

export interface QueuedScan {
  enqueued_at: string;
  attempt: number;
  payload: ScanPayload;
}

/**
 * Khoá so trùng ổn định của một lượt quét trong hàng đợi. KHÔNG dùng
 * `agent_event_id` một mình: dòng cũ thiếu id được `readAll` gán id NGẪU
 * NHIÊN mỗi lần đọc, nên hai lần đọc cho hai id khác nhau.
 */
export function scanQueueKey(item: QueuedScan): string {
  const p = item.payload;
  return `${p.scanner_device_code}|${p.scanned_at}|${p.raw_value}`;
}

/**
 * HIGH-19 (B4): JSONL queue with atomic write + fsync + serialized writer.
 *
 * Chống:
 *   - Cắt điện giữa `writeFile` → file cắt đôi → parser silent-drop dòng.
 *   - 2 writer đồng thời rewrite → nội dung xen kẽ.
 *   - Silent-drop dòng corrupt → mất scan.
 *
 * Design:
 *   - append(): dùng appendFile (không cần atomic — append là O_APPEND
 *     atomic ở OS level cho ghi < PIPE_BUF ~ 4KB, đủ 1 JSON line).
 *   - rewrite(): dùng atomic tmp+fsync+rename qua SerializedWriter với
 *     coalesce 50ms — nếu caller gọi rewrite nhiều lần liền, chỉ write
 *     nội dung cuối cùng.
 *   - readAll(): nếu parse fail bất kỳ dòng nào → quarantine toàn file
 *     sang `_quarantine/queue-corrupt/`, trả về [] (không silent-drop).
 */
export class ScanQueue {
  private readonly writer: SerializedWriter<QueuedScan[]>;
  /** 0.13.0: thêm và bớt không được chen nhau — xem queue-lock.ts. */
  private readonly mutex = new AsyncMutex();

  constructor(private readonly filePath: string) {
    this.writer = new SerializedWriter(50, async (items) => {
      const body =
        items.length === 0
          ? ""
          : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
      await atomicWriteFile(this.filePath, body);
    });
  }

  async append(scan: ScanPayload): Promise<void> {
    await this.mutex.run(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const line: QueuedScan = {
        enqueued_at: new Date().toISOString(),
        attempt: 0,
        payload: scan,
      };
      await fs.appendFile(this.filePath, JSON.stringify(line) + "\n", "utf8");
    });
  }

  /**
   * 0.13.0: bỏ những dòng đã gửi xong (hoặc bị từ chối vĩnh viễn). Đọc lại
   * file MỚI NHẤT trong khoá — dòng vừa được thêm trong lúc đang gửi vẫn còn
   * nguyên. Thay cho `rewrite(remaining)` (ghi đè bằng bản chụp cũ).
   */
  async removeWhere(drop: (item: QueuedScan) => boolean): Promise<void> {
    await this.mutex.run(async () => {
      const current = await this.readAll();
      const keep = current.filter((item) => !drop(item));
      if (keep.length === current.length) return;
      const body = keep.length === 0 ? "" : keep.map((i) => JSON.stringify(i)).join("\n") + "\n";
      await atomicWriteFile(this.filePath, body);
    });
  }

  async readAll(): Promise<QueuedScan[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const items: QueuedScan[] = [];
    let corrupt = 0;
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as QueuedScan;
        if (item.payload && !item.payload.agent_event_id) {
          item.payload.agent_event_id = randomUUID();
        }
        items.push(item);
      } catch {
        corrupt++;
      }
    }
    // HIGH-19: nếu bất kỳ dòng nào không parse được, quarantine file
    // gốc thay vì silent-drop. Ops có thể inspect và recover manually.
    if (corrupt > 0) {
      const dest = await quarantineCorruptQueue(
        this.filePath,
        `parse_${corrupt}_lines`,
      );
      console.error(
        `[queue] ${corrupt} corrupt line(s) in ${this.filePath} — file quarantined to ${dest ?? "<failed>"}`,
      );
      return items;
    }
    return items;
  }

  /**
   * 0.13.0: số lượt quét đang chờ gửi — cho bản tự khai. Chỉ đếm dòng, không
   * parse, không quarantine: đường đếm không được có tác dụng phụ. File
   * thường rỗng hoặc vài dòng.
   */
  async count(): Promise<number> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }

  async rewrite(items: QueuedScan[]): Promise<void> {
    return this.writer.schedule(items);
  }

  /**
   * Shutdown path — flush pending write NGAY LẬP TỨC. Bảo đảm queue sync
   * trước exit.
   */
  async flushNow(): Promise<void> {
    return this.writer.flushNow();
  }
}
