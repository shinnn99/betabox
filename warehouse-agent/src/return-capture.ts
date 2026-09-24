import { promises as fs } from "node:fs";
import path from "node:path";
import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { fetchWithRetrySigned } from "./fetch-error";

/**
 * Phiên ghi hoàn phía agent.
 *
 * Camera của bàn vẫn ghi liên tục cho luồng đóng hàng. Việc của module
 * này là GÁN NHÃN: đoạn video nào thuộc về phiên hàng hoàn. Chỉ gán khi
 * cloud đã gửi tín hiệu BẬT — không có tín hiệu thì không nhãn nào được
 * gán (chốt của chủ dự án 21/09/2026).
 *
 * Luật chuyển module (chủ dự án chốt 21/09/2026), áp y hệt cho CẢ HAI
 * chiều: đoạn 60 giây đang ghi dở lúc chuyển module thì ghi nốt và vẫn
 * thuộc module CŨ; module mới nhận từ đoạn KẾ TIẾP. Chuyển lại thì lại
 * bắt đầu từ đoạn kế tiếp nữa.
 *
 *   ĐÓNG HÀNG → HOÀN : đoạn dở là của đóng hàng (camera "hoãn nhận").
 *   HOÀN → ĐÓNG HÀNG : đoạn dở là của phiên hoàn (phiên "đang rút"),
 *                      phiên chỉ kết thúc khi đoạn đó đóng hẳn.
 *
 * Vì vậy agent phải giữ ĐƯỢC NHIỀU PHIÊN cùng lúc:
 *   - chuyển hoàn → đóng hàng → hoàn trong cùng một đoạn: phiên cũ còn
 *     đang rút (chờ đoạn dở) trong khi phiên mới đã bật;
 *   - nhiều bàn cùng nhận hoàn, mỗi bàn một phiên, camera khác nhau.
 * Bản đầu chỉ giữ một phiên: bàn thứ hai bật là đè mất phiên bàn thứ nhất,
 * và chuyển qua lại nhanh làm đoạn dở mất nhãn. Đã có test cho cả hai.
 *
 * Trạng thái ghi xuống file: agent khởi động lại giữa chừng thì không được
 * quên phiên, vì quên nghĩa là gán nhãn mãi không dừng (nếu đang BẬT) hoặc
 * treo phiên ở cloud (nếu đang rút).
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

const STATE_FILENAME = "return-capture.json";

interface CaptureEntry {
  capture_id: string;
  station_id: string;
  camera_ids: string[];
  /** true = đã nhận TẮT, đang chờ các đoạn dở đóng lại. */
  draining: boolean;
  /** Camera còn đoạn dở CỦA PHIÊN NÀY lúc nhận TẮT. Rỗng + draining = xong. */
  pending_cameras: string[];
  /**
   * Camera đang ghi dở một đoạn KHÔNG thuộc phiên này lúc nhận BẬT (đoạn
   * của luồng đóng hàng, hoặc đoạn cuối của phiên hoàn trước đang rút).
   * Phiên này nhận từ đoạn kế tiếp.
   */
  deferred_cameras: string[];
  /** Mốc kết thúc muộn nhất trong các đoạn mang nhãn phiên này. */
  last_segment_ended_at: string | null;
}

interface PersistedFile {
  captures: CaptureEntry[];
  /** Phiên đã kết thúc gần đây — xem `finishedIds`. */
  finished_ids?: string[];
  updated_at: string;
}

/** Đủ lớn để phủ mọi lệnh còn nằm trong hàng đợi, đủ nhỏ để file không phình. */
const FINISHED_MEMORY = 100;

export interface CaptureSignal {
  capture_id: string;
  station_id: string;
  camera_ids: string[];
  active: boolean;
}

export interface ReturnCaptureDeps {
  /** Đọc lúc gọi, không lúc khởi tạo: cloud dev có thể đổi cổng giữa chừng. */
  getBackendUrl: () => string;
  agentCode: string;
  agentSecret: string;
  /** Camera này có đoạn video đang ghi dở không (SegmentTracker trả lời). */
  hasOpenSegment: (cameraId: string) => boolean;
  /** Thay đường gửi lên cloud — chỉ dùng trong test. */
  send?: (payload: Record<string, unknown>) => Promise<boolean>;
}

function statePath(): string {
  return path.join(process.cwd(), STATE_FILENAME);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
}

function parseEntry(raw: unknown): CaptureEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.capture_id !== "string" || typeof r.station_id !== "string") return null;
  return {
    capture_id: r.capture_id,
    station_id: r.station_id,
    camera_ids: strings(r.camera_ids),
    draining: Boolean(r.draining),
    pending_cameras: strings(r.pending_cameras),
    deferred_cameras: strings(r.deferred_cameras),
    last_segment_ended_at:
      typeof r.last_segment_ended_at === "string" ? r.last_segment_ended_at : null,
  };
}

export class ReturnCaptureStore {
  private readonly captures = new Map<string, CaptureEntry>();
  /**
   * Phiên đã kết thúc. Lệnh BẬT giao trễ sau khi phiên đã xong (mất mạng
   * rồi có lại, lệnh bị giao lại) không được làm phiên sống lại — sống lại
   * là gán nhãn mãi không dừng, vì cloud sẽ không bao giờ gửi TẮT lần nữa.
   */
  private finishedIds: string[] = [];
  private readonly deps: ReturnCaptureDeps;

  constructor(deps: ReturnCaptureDeps) {
    this.deps = deps;
  }

  /**
   * Đọc lại trạng thái sau khi agent khởi động.
   *
   * Phiên đang rút mà camera không còn đoạn dở (ffmpeg đã chết theo agent)
   * thì báo xong luôn — không có gì để chờ nữa.
   */
  async load(): Promise<void> {
    this.captures.clear();
    try {
      const raw = JSON.parse(await fs.readFile(statePath(), "utf8")) as Record<string, unknown>;
      // Bản đầu ghi MỘT phiên ở gốc file; bản này ghi mảng. Đọc được cả hai
      // để nâng cấp agent giữa phiên không làm mất phiên đang chạy.
      const list = Array.isArray(raw.captures) ? raw.captures : [raw];
      for (const item of list) {
        const entry = parseEntry(item);
        if (entry) this.captures.set(entry.capture_id, entry);
      }
      this.finishedIds = strings(raw.finished_ids).slice(-FINISHED_MEMORY);
    } catch {
      return;
    }
    for (const c of this.captures.values()) {
      console.log(
        `[return-capture] khôi phục phiên ${c.capture_id} (${c.draining ? "đang rút" : "đang bật"})`,
      );
    }
    // Chép ra mảng trước: finishIfDrained xoá phiên khỏi Map giữa vòng lặp.
    for (const c of [...this.captures.values()]) {
      if (c.draining) await this.finishIfDrained(c);
    }
  }

  /**
   * Nhãn cho đoạn video ĐANG MỞ (hoặc vừa đóng) của camera này.
   *
   * Thứ tự ưu tiên chính là luật chuyển module:
   *   1. Phiên đang rút mà đoạn dở của camera là của nó → nhãn phiên đó.
   *   2. Phiên đang bật có camera, và camera không bị hoãn → nhãn phiên đó.
   *   3. Còn lại → không nhãn (đoạn của luồng đóng hàng).
   */
  labelFor(cameraId: string): string | null {
    for (const c of this.captures.values()) {
      if (c.draining && c.pending_cameras.includes(cameraId)) return c.capture_id;
    }
    for (const c of this.captures.values()) {
      if (c.draining) continue;
      if (!c.camera_ids.includes(cameraId)) continue;
      if (c.deferred_cameras.includes(cameraId)) continue;
      return c.capture_id;
    }
    return null;
  }

  /**
   * Đồng bộ với danh sách phiên ĐANG BẬT mà cloud gửi kèm mỗi nhịp
   * heartbeat.
   *
   * Vì sao phải có (sự cố 24/09/2026 — "chuyển từ đóng hàng sang hoàn
   * hàng thì được, chuyển ngược lại thì không"): trước đây agent chỉ biết
   * tắt phiên khi nhận được LỆNH tắt, mà lệnh đó chỉ sinh ra từ đúng một
   * đường (người dùng bấm Kết thúc và mình là người giữ cuối cùng). Bốn
   * đường còn lại — bàn tự về sau 5 phút, đóng ca, đổi mục đích bàn, hết
   * hạn phiên — đều đóng kỳ THẲNG TRONG DATABASE, không ai báo agent. Agent
   * giữ phiên mãi, tiếp tục gán nhãn hàng hoàn cho video đóng hàng, và
   * video đơn đi bị xoá theo hạn 7 ngày của hàng hoàn.
   *
   * Kiểm chứng trên database thật: mọi lệnh `set_return_capture` từng gửi
   * đều `active=true`, chưa từng có một lệnh tắt nào.
   *
   * Giờ cloud gửi DANH SÁCH phiên đang bật; phiên nào agent giữ mà không
   * có trong danh sách thì tắt. Trễ nhất là một nhịp heartbeat.
   */
  async reconcile(active: CaptureSignal[]): Promise<void> {
    const wanted = new Map(active.map((c) => [c.capture_id, c]));

    for (const entry of [...this.captures.values()]) {
      if (entry.draining) continue;
      if (wanted.has(entry.capture_id)) continue;
      console.warn(
        `[return-capture] cloud không còn phiên ${entry.capture_id} — tắt theo trạng thái cloud`,
      );
      await this.apply({
        capture_id: entry.capture_id,
        station_id: entry.station_id,
        camera_ids: entry.camera_ids,
        active: false,
      });
    }

    for (const signal of wanted.values()) {
      const existing = this.captures.get(signal.capture_id);
      if (existing && !existing.draining) {
        if (existing.camera_ids.join() !== signal.camera_ids.join()) {
          existing.camera_ids = [...signal.camera_ids];
          await this.persist();
        }
        continue;
      }
      if (existing?.draining) continue;
      // Phiên cloud đang bật mà agent không giữ: lệnh BẬT rơi mất, hoặc
      // agent vừa khởi động lại. Nhận lại — `finishedIds` không chặn
      // đường này, vì đây là trạng thái HIỆN TẠI của cloud chứ không phải
      // một lệnh cũ giao trễ.
      this.finishedIds = this.finishedIds.filter((id) => id !== signal.capture_id);
      console.warn(`[return-capture] nhận lại phiên ${signal.capture_id} theo trạng thái cloud`);
      await this.apply({ ...signal, active: true });
    }
  }

  /** Nhận tín hiệu BẬT/TẮT từ cloud. Idempotent theo capture_id. */
  async apply(signal: CaptureSignal): Promise<void> {
    const existing = this.captures.get(signal.capture_id);

    if (signal.active) {
      if (this.finishedIds.includes(signal.capture_id)) {
        console.warn(
          `[return-capture] bỏ qua lệnh BẬT giao trễ của phiên đã kết thúc ${signal.capture_id}`,
        );
        return;
      }
      if (existing && !existing.draining) {
        // Gửi lại lệnh BẬT của đúng phiên đang chạy: chỉ cập nhật danh
        // sách camera (bàn có thể vừa được gắn thêm camera).
        existing.camera_ids = signal.camera_ids;
        await this.persist();
        return;
      }
      if (existing?.draining) {
        // Lệnh BẬT cũ giao trễ sau lệnh TẮT: phiên này đã kết thúc ở cloud,
        // không được sống lại.
        return;
      }

      // Đoạn đang ghi dở lúc BẬT không phải của phiên này — dù nó là đoạn
      // của luồng đóng hàng hay đoạn cuối của phiên hoàn trước đang rút.
      const deferred = signal.camera_ids.filter((c) => this.deps.hasOpenSegment(c));
      this.captures.set(signal.capture_id, {
        capture_id: signal.capture_id,
        station_id: signal.station_id,
        camera_ids: signal.camera_ids,
        draining: false,
        pending_cameras: [],
        deferred_cameras: deferred,
        last_segment_ended_at: null,
      });
      await this.persist();
      console.log(
        `[return-capture] BẬT phiên ${signal.capture_id} bàn=${signal.station_id} camera=${signal.camera_ids.length}` +
          (deferred.length > 0
            ? ` — ${deferred.length} đoạn của module trước đang ghi dở, để chúng lưu nốt rồi mới nhận`
            : ""),
      );
      return;
    }

    // TẮT.
    if (!existing) {
      // Không giữ phiên này (agent vừa khởi động, hoặc lệnh giao hai lần).
      // Vẫn báo xong để cloud không treo phiên chờ mãi, và nhớ nó đã xong
      // để một lệnh BẬT giao trễ không làm nó sống lại.
      await this.reportFinishById(signal.capture_id, null);
      if (!this.finishedIds.includes(signal.capture_id)) {
        this.finishedIds = [...this.finishedIds, signal.capture_id].slice(-FINISHED_MEMORY);
        await this.persist();
      }
      return;
    }
    if (existing.draining) return;

    // Chỉ chờ những camera đang ghi dở một đoạn CỦA PHIÊN NÀY. Camera còn
    // đang hoãn nhận thì đoạn dở là của module trước — chờ nó là treo
    // phiên vì một đoạn không thuộc mình.
    existing.pending_cameras = existing.camera_ids.filter(
      (c) =>
        this.deps.hasOpenSegment(c) &&
        !existing.deferred_cameras.includes(c) &&
        this.labelFor(c) === existing.capture_id,
    );
    existing.draining = true;
    existing.deferred_cameras = [];
    await this.persist();
    console.log(
      `[return-capture] TẮT phiên ${signal.capture_id}, chờ ${existing.pending_cameras.length} đoạn đang ghi dở lưu nốt`,
    );
    await this.finishIfDrained(existing);
  }

  /**
   * Một đoạn video vừa đóng. Gọi SAU khi đã gán nhãn cho nó.
   *
   * Đây là chỗ duy nhất quyết định "đoạn dở đã lưu xong": module cũ nhả
   * camera, module mới bắt đầu nhận từ đoạn kế tiếp.
   */
  async noteSegmentClosed(cameraId: string, endedAt: string | null): Promise<void> {
    const owner = this.labelFor(cameraId);
    const finished: CaptureEntry[] = [];
    let changed = false;

    for (const c of this.captures.values()) {
      if (!c.camera_ids.includes(cameraId) && !c.pending_cameras.includes(cameraId)) continue;

      if (c.capture_id === owner && endedAt) {
        if (!c.last_segment_ended_at || endedAt > c.last_segment_ended_at) {
          c.last_segment_ended_at = endedAt;
          changed = true;
        }
      }
      if (c.deferred_cameras.includes(cameraId)) {
        // Đoạn của module trước đã lưu xong: từ đoạn kế tiếp là của phiên này.
        c.deferred_cameras = c.deferred_cameras.filter((x) => x !== cameraId);
        changed = true;
      }
      if (c.draining && c.pending_cameras.includes(cameraId)) {
        c.pending_cameras = c.pending_cameras.filter((x) => x !== cameraId);
        changed = true;
        if (c.pending_cameras.length === 0) finished.push(c);
      }
    }

    if (changed) await this.persist();
    for (const c of finished) await this.finishIfDrained(c);
  }

  private async finishIfDrained(c: CaptureEntry): Promise<void> {
    if (!c.draining) return;
    if (c.pending_cameras.some((cam) => this.deps.hasOpenSegment(cam))) return;
    if (c.pending_cameras.length > 0) {
      // Camera không còn ghi nữa (ffmpeg chết) → không bao giờ có đoạn
      // đóng để chờ. Không treo phiên vì chuyện đó.
      console.warn(
        `[return-capture] phiên ${c.capture_id}: ${c.pending_cameras.length} camera không còn ghi, kết thúc theo mốc đang có`,
      );
    }
    const ok = await this.reportFinishById(c.capture_id, c.last_segment_ended_at);
    if (!ok) {
      // Giữ lại để lần sau thử tiếp; cloud có lối bỏ rơi sau 15 phút nên
      // phiên không treo vĩnh viễn ở phía kia.
      return;
    }
    this.captures.delete(c.capture_id);
    this.finishedIds = [...this.finishedIds, c.capture_id].slice(-FINISHED_MEMORY);
    await this.persist();
    console.log(`[return-capture] XONG phiên ${c.capture_id}`);
  }

  private async reportFinishById(
    captureId: string,
    lastSegmentEndedAt: string | null,
  ): Promise<boolean> {
    return this.post({
      capture_id: captureId,
      action: "finish",
      last_segment_ended_at: lastSegmentEndedAt,
    });
  }

  /** Báo cloud là đã nhận tín hiệu. Trước mốc này chưa có nhãn nào. */
  async reportAck(captureId: string): Promise<boolean> {
    return this.post({ capture_id: captureId, action: "ack" });
  }

  private async post(payload: Record<string, unknown>): Promise<boolean> {
    if (this.deps.send) return this.deps.send(payload);
    const body = JSON.stringify(payload);
    try {
      const res = await fetchWithRetrySigned(
        `${this.deps.getBackendUrl()}${AGENT_API_PATHS.returnCapture}`,
        () => ({
          method: "POST",
          headers: signBodyV2({
            agentCode: this.deps.agentCode,
            agentSecret: this.deps.agentSecret,
            method: "POST",
            canonicalPath: AGENT_API_PATHS.returnCapture,
            body,
          }),
          body,
          redirect: "manual",
        }),
      );
      return res.ok;
    } catch (err) {
      console.warn(`[return-capture] báo cloud lỗi: ${(err as Error).message}`);
      return false;
    }
  }

  private async persist(): Promise<void> {
    const target = statePath();
    // Không xoá file khi hết phiên: danh sách phiên đã kết thúc phải sống
    // qua khởi động lại, đúng lúc lệnh cũ dễ bị giao lại nhất.
    const content: PersistedFile = {
      captures: [...this.captures.values()],
      finished_ids: this.finishedIds,
      updated_at: new Date().toISOString(),
    };
    const tmp = `${target}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(content, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      console.warn(`[return-capture] ghi trạng thái lỗi: ${(err as Error).message}`);
    }
  }
}
