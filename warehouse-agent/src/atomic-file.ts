import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * HIGH-19 (B4): atomic write helper cho queue nghiệp vụ.
 *
 * Yêu cầu:
 *   1. Ghi temp file trong cùng thư mục canonical (cùng volume → rename
 *      atomic trên NTFS/POSIX).
 *   2. `FileHandle.sync()` (fsync) trước khi close — đảm bảo dữ liệu đã
 *      xuống ổ, không bị mất khi cắt điện.
 *   3. Close handle.
 *   4. Rename temp → canonical (atomic).
 *
 * Trên Windows Node 24 không có directory-fsync ổn định; bỏ qua bước
 * đó theo prompt B4 chốt.
 *
 * KHÔNG serialized/coalesced ở đây — queue class ngoài quản lý writer
 * mutex + coalesce interval.
 */

export async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const dir = dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  const tmp = resolve(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  // Mở với 'w' — tạo mới hoặc truncate.
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(data, "utf8");
    // fsync — force flush đến ổ vật lý.
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Rename atomic. Trên Windows nếu canonical tồn tại và đang bị lock
  // (hiếm với queue của agent), rename sẽ throw. Vẫn giữ tmp file để lần
  // sau retry.
  await fsp.rename(tmp, filePath);
}

/**
 * Corrupt file handler: nếu parse queue fail, MOVE file sang
 * `_quarantine/queue-corrupt/<timestamp>_<basename>` thay vì silent-drop.
 *
 * Trả path đã quarantine hoặc null nếu không quarantine được.
 */
export async function quarantineCorruptQueue(
  filePath: string,
  reason: string,
  now: Date = new Date(),
): Promise<string | null> {
  const dir = dirname(filePath);
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const safeReason = reason.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  const quarantineDir = resolve(dir, "_quarantine", "queue-corrupt");
  try {
    await fsp.mkdir(quarantineDir, { recursive: true });
    const dest = resolve(
      quarantineDir,
      `${ts}_${basename(filePath)}_${safeReason}`,
    );
    if (!existsSync(filePath)) return null;
    await fsp.rename(filePath, dest);
    return dest;
  } catch (err) {
    console.error(
      `[queue-quarantine] failed to quarantine ${filePath}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Serialized writer mutex — mỗi queue file chỉ 1 write in-flight cùng
 * lúc. Cộng với coalesce interval (agent gọi rewrite N lần nhanh → chỉ
 * write 1 lần cuối).
 *
 * Impl: chờ pending, replace pending bằng payload mới, timer flush sau
 * `coalesceMs`. Bảo đảm không double-write cùng payload cũ khi caller
 * gọi liên tiếp.
 */
interface PendingBatch<T> {
  payload: T;
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
}

export class SerializedWriter<T> {
  // "next" = batch đang gộp waiter, chưa flush. Ghi đè payload; giữ tất
  // cả waiter cho lần flush kế tiếp.
  private next: PendingBatch<T> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writingPromise: Promise<void> | null = null;

  constructor(
    private readonly coalesceMs: number,
    private readonly writer: (payload: T) => Promise<void>,
  ) {}

  async schedule(payload: T): Promise<void> {
    if (!this.next) {
      this.next = { payload, waiters: [] };
    } else {
      this.next.payload = payload; // coalesce: giữ payload mới nhất
    }
    const p = new Promise<void>((resolve, reject) => {
      this.next!.waiters.push({ resolve, reject });
    });
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.doFlush();
      }, this.coalesceMs);
    }
    return p;
  }

  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.doFlush();
  }

  private async doFlush(): Promise<void> {
    // Chờ write đang chạy xong TRƯỚC khi start batch tiếp theo — bảo
    // đảm strict sequential.
    if (this.writingPromise) {
      await this.writingPromise.catch(() => undefined);
    }
    if (!this.next) return;
    const batch = this.next;
    this.next = null;
    this.writingPromise = (async () => {
      try {
        await this.writer(batch.payload);
        for (const w of batch.waiters) w.resolve();
      } catch (err) {
        for (const w of batch.waiters) w.reject(err);
      } finally {
        this.writingPromise = null;
      }
    })();
    await this.writingPromise.catch(() => undefined);
  }
}
