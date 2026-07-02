import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * "Desired state" của recording — trên đĩa local agent.
 *
 * BLOCKS-GO-LIVE (nhắc lại): file này CHỈ chứa camera_id + session_id.
 * KHÔNG được thêm rtsp_url/username/password xuống đây — plaintext
 * credential trên đĩa máy khách là bước lùi so với kiến trúc cũ (đã
 * mã hóa bằng CAMERA_SECRET_KEY). Boot lấy credential qua endpoint
 * /api/agent/recording-credentials trên đường HTTPS + HMAC.
 *
 * File trả lời câu "khi agent boot lại, camera nào NÊN đang ghi".
 * Không phản ánh runtime (pid, ffmpeg alive) — runtime giữ trong RAM.
 * Ghi bằng atomic write (tmp + rename) để tránh nửa-file khi crash.
 */
export interface DesiredEntry {
  camera_id: string;
  session_id: string;
  desired_since: string;
}

interface FileShape {
  version: 1;
  cameras: Record<string, DesiredEntry>;
}

export class DesiredStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Map<string, DesiredEntry>> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as FileShape;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
        return new Map();
      }
      const out = new Map<string, DesiredEntry>();
      for (const [cid, entry] of Object.entries(parsed.cameras ?? {})) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.camera_id === "string" &&
          typeof entry.session_id === "string" &&
          typeof entry.desired_since === "string"
        ) {
          out.set(cid, entry);
        }
      }
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return new Map();
      throw err;
    }
  }

  async save(entries: Map<string, DesiredEntry>): Promise<void> {
    const obj: FileShape = {
      version: 1,
      cameras: Object.fromEntries(entries),
    };
    const json = JSON.stringify(obj, null, 2);
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = resolve(dir, `.desired-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, json, "utf8");
    // Rename là atomic trên cả POSIX và Windows (cùng volume). Nếu
    // crash giữa writeFile và rename, file gốc không bị hư — tmp file
    // orphan bị bỏ (dọn thủ công nếu ai để ý). Không dùng append.
    await fs.rename(tmp, this.path);
  }
}
