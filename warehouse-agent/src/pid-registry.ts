import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * CRIT-1 (B2): PID registry cho ffmpeg child processes.
 *
 * Bối cảnh review Vòng B:
 *   - Agent chạy 24/7 ở Windows kho.
 *   - Bị `kill -9` / Task Manager End Task / OOM / crash native → skip
 *     cả SIGINT/SIGTERM handler → `shutdown()` không chạy.
 *   - Windows KHÔNG dùng Job Object mặc định → ffmpeg con KHÔNG bị OS reap.
 *   - Agent restart: `startupSet + runningMap` là RAM cục bộ → không biết
 *     ffmpeg cũ còn sống → spawn ffmpeg thứ 2 → camera 1-connection RTSP
 *     reject → mất recording camera đó vĩnh viễn.
 *
 * Fix (B2 CRIT-1):
 *   1. PID registry file JSON persist mỗi lần spawn/exit (atomic tmp+rename).
 *   2. Boot recovery: đọc registry, kill ffmpeg zombie bằng PID+command
 *      fingerprint (chống kill nhầm PID đã tái sử dụng bởi process khác).
 *   3. Job Object (best-effort): spawn với `windowsHide + detached: false`,
 *      thêm Job Object nếu extension khả thi — task đóng job = kill mọi
 *      child. Không dùng dependency native (không thêm build risk); dùng
 *      thay bằng `taskkill /T /F` khi cần force cleanup.
 *
 * File shape:
 *   { version: 1, entries: { <cameraId>: { pid, cameraCode, sessionId, startedAt, fingerprint } } }
 *
 * fingerprint = SHA-256 hash của command args (rtsp path + segment pattern).
 * Khi boot recovery, verify PID còn sống + command line match fingerprint
 * để KHÔNG kill nhầm process khác nào đó vừa tái sử dụng PID.
 */

export interface PidEntry {
  cameraId: string;
  cameraCode: string;
  sessionId: string;
  pid: number;
  startedAt: string;
  /**
   * SHA-256 hex của command line args fed to ffmpeg (rtsp path + segment
   * pattern + transport). Boot recovery so command line thực tế của PID
   * đó với fingerprint — chỉ kill nếu match.
   */
  fingerprint: string;
}

interface FileShape {
  version: 1;
  entries: Record<string, PidEntry>;
}

export class PidRegistry {
  private cache: Map<string, PidEntry> | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<Map<string, PidEntry>> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as FileShape;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
        this.cache = new Map();
        return this.cache;
      }
      const out = new Map<string, PidEntry>();
      for (const [cid, entry] of Object.entries(parsed.entries ?? {})) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.cameraId === "string" &&
          typeof entry.cameraCode === "string" &&
          typeof entry.sessionId === "string" &&
          typeof entry.pid === "number" &&
          typeof entry.startedAt === "string" &&
          typeof entry.fingerprint === "string"
        ) {
          out.set(cid, entry);
        }
      }
      this.cache = out;
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = new Map();
        return this.cache;
      }
      throw err;
    }
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    const obj: FileShape = {
      version: 1,
      entries: Object.fromEntries(this.cache),
    };
    const json = JSON.stringify(obj, null, 2);
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = resolve(dir, `.ffmpeg-pids-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, this.path);
  }

  async set(entry: PidEntry): Promise<void> {
    await this.load();
    this.cache!.set(entry.cameraId, entry);
    await this.persist();
  }

  async remove(cameraId: string): Promise<void> {
    await this.load();
    if (!this.cache!.has(cameraId)) return;
    this.cache!.delete(cameraId);
    await this.persist();
  }

  async list(): Promise<PidEntry[]> {
    const map = await this.load();
    return Array.from(map.values());
  }

  async clear(): Promise<void> {
    await this.load();
    this.cache!.clear();
    await this.persist();
  }
}

import { createHash } from "node:crypto";

/**
 * Fingerprint deterministic từ ffmpeg args. Args nhạy cảm (rtsp URL với
 * password) được hash — không lưu plaintext.
 */
export function fingerprintArgs(args: string[]): string {
  return createHash("sha256").update(args.join("\x00")).digest("hex");
}
