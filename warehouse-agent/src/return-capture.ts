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
 * Phần khó nằm ở lúc TẮT. Người dùng thoát giao diện giữa lúc ffmpeg đang
 * ghi dở một đoạn 60 giây. Đoạn đó phải thuộc về phiên (nó chứa phần cuối
 * của việc mở kiện), nên agent chuyển sang trạng thái "đang rút": vẫn gán
 * nhãn cho các camera còn đoạn dở, chờ chúng đóng, rồi mới báo cloud là
 * xong. Việc chờ này chạy ở agent nên không phụ thuộc trình duyệt còn mở.
 *
 * Trạng thái ghi xuống file: agent khởi động lại giữa chừng thì không được
 * quên phiên, vì quên nghĩa là gán nhãn mãi không dừng (nếu đang BẬT) hoặc
 * treo phiên vĩnh viễn ở cloud (nếu đang rút).
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

const STATE_FILENAME = "return-capture.json";

interface PersistedState {
  capture_id: string;
  station_id: string;
  camera_ids: string[];
  /** true = đã nhận TẮT, đang chờ các đoạn dở đóng lại. */
  draining: boolean;
  /** Camera còn đoạn dở lúc nhận TẮT. Rỗng + draining = báo xong được. */
  pending_cameras: string[];
  /** Mốc kết thúc muộn nhất trong các đoạn đã đóng của phiên. */
  last_segment_ended_at: string | null;
  updated_at: string;
}

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
}

function statePath(): string {
  return path.join(process.cwd(), STATE_FILENAME);
}

export class ReturnCaptureStore {
  private state: PersistedState | null = null;

  constructor(private readonly deps: ReturnCaptureDeps) {}

  /**
   * Đọc lại trạng thái sau khi agent khởi động.
   *
   * Nếu đang rút mà không camera nào còn đoạn dở (ffmpeg đã chết theo
   * agent) thì báo xong luôn — không có gì để chờ nữa.
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (
        typeof parsed.capture_id !== "string" ||
        typeof parsed.station_id !== "string" ||
        !Array.isArray(parsed.camera_ids)
      ) {
        this.state = null;
        return;
      }
      this.state = {
        capture_id: parsed.capture_id,
        station_id: parsed.station_id,
        camera_ids: parsed.camera_ids.filter((c): c is string => typeof c === "string"),
        draining: Boolean(parsed.draining),
        pending_cameras: Array.isArray(parsed.pending_cameras)
          ? parsed.pending_cameras.filter((c): c is string => typeof c === "string")
          : [],
        last_segment_ended_at:
          typeof parsed.last_segment_ended_at === "string" ? parsed.last_segment_ended_at : null,
        updated_at: new Date().toISOString(),
      };
      console.log(
        `[return-capture] khôi phục phiên ${this.state.capture_id} (${this.state.draining ? "đang rút" : "đang bật"})`,
      );
      if (this.state.draining) {
        await this.finishIfDrained();
      }
    } catch {
      this.state = null;
    }
  }

  /** Nhãn cho một đoạn video của camera này, hoặc null nếu không thuộc phiên. */
  labelFor(cameraId: string): string | null {
    const s = this.state;
    if (!s) return null;
    if (!s.camera_ids.includes(cameraId)) return null;
    // Đang rút: chỉ còn gán cho camera có đoạn dở từ trước lúc TẮT. Đoạn
    // MỚI mở sau đó là của việc khác, không phải hàng hoàn.
    if (s.draining && !s.pending_cameras.includes(cameraId)) return null;
    return s.capture_id;
  }

  /** Nhận tín hiệu BẬT/TẮT từ cloud. Idempotent theo capture_id. */
  async apply(signal: CaptureSignal): Promise<void> {
    if (signal.active) {
      const same = this.state?.capture_id === signal.capture_id;
      if (same && !this.state!.draining) {
        // Gửi lại lệnh BẬT của đúng phiên đang chạy: chỉ cập nhật danh
        // sách camera (bàn có thể vừa được gắn thêm camera).
        this.state!.camera_ids = signal.camera_ids;
        await this.persist();
        return;
      }
      if (this.state && this.state.capture_id !== signal.capture_id && this.state.draining) {
        // Phiên cũ chưa rút xong mà đã có phiên mới: báo xong phiên cũ
        // bằng mốc đang có, đừng để nó treo ở cloud.
        await this.reportFinish(this.state);
      }
      this.state = {
        capture_id: signal.capture_id,
        station_id: signal.station_id,
        camera_ids: signal.camera_ids,
        draining: false,
        pending_cameras: [],
        last_segment_ended_at: null,
        updated_at: new Date().toISOString(),
      };
      await this.persist();
      console.log(
        `[return-capture] BẬT phiên ${signal.capture_id} bàn=${signal.station_id} camera=${signal.camera_ids.length}`,
      );
      return;
    }

    // TẮT.
    if (!this.state || this.state.capture_id !== signal.capture_id) {
      // Không giữ phiên này (agent vừa khởi động, hoặc lệnh giao hai lần).
      // Vẫn báo xong để cloud không treo phiên chờ mãi.
      await this.reportFinishById(signal.capture_id, null);
      return;
    }
    if (this.state.draining) return;

    this.state.draining = true;
    this.state.pending_cameras = this.state.camera_ids.filter((c) =>
      this.deps.hasOpenSegment(c),
    );
    await this.persist();
    console.log(
      `[return-capture] TẮT phiên ${signal.capture_id}, chờ ${this.state.pending_cameras.length} đoạn đang ghi dở`,
    );
    await this.finishIfDrained();
  }

  /**
   * Một đoạn video vừa đóng. Gọi SAU khi đã gán nhãn cho nó.
   *
   * Đây là chỗ duy nhất quyết định "đoạn cuối đã lưu xong": chỉ khi mọi
   * camera có đoạn dở lúc TẮT đều đã đóng đoạn đó thì phiên mới hết.
   */
  async noteSegmentClosed(cameraId: string, endedAt: string | null): Promise<void> {
    const s = this.state;
    if (!s || !s.camera_ids.includes(cameraId)) return;

    if (endedAt) {
      if (!s.last_segment_ended_at || endedAt > s.last_segment_ended_at) {
        s.last_segment_ended_at = endedAt;
      }
    }
    if (!s.draining) {
      await this.persist();
      return;
    }
    s.pending_cameras = s.pending_cameras.filter((c) => c !== cameraId);
    await this.persist();
    await this.finishIfDrained();
  }

  private async finishIfDrained(): Promise<void> {
    const s = this.state;
    if (!s || !s.draining) return;
    if (s.pending_cameras.some((c) => this.deps.hasOpenSegment(c))) return;
    if (s.pending_cameras.length > 0) {
      // Camera không còn ghi nữa (ffmpeg chết) → không bao giờ có đoạn
      // đóng để chờ. Không treo phiên vì chuyện đó.
      console.warn(
        `[return-capture] phiên ${s.capture_id}: ${s.pending_cameras.length} camera không còn ghi, kết thúc theo mốc đang có`,
      );
    }
    await this.reportFinish(s);
  }

  private async reportFinish(s: PersistedState): Promise<void> {
    const ok = await this.reportFinishById(s.capture_id, s.last_segment_ended_at);
    if (!ok) {
      // Giữ trạng thái lại để lần sau thử tiếp; cloud có lối bỏ rơi sau
      // 15 phút nên phiên không treo vĩnh viễn ở phía kia.
      return;
    }
    if (this.state?.capture_id === s.capture_id) {
      this.state = null;
      await this.clear();
    }
    console.log(`[return-capture] XONG phiên ${s.capture_id}`);
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
    if (!this.state) return this.clear();
    this.state.updated_at = new Date().toISOString();
    const target = statePath();
    const tmp = `${target}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      console.warn(`[return-capture] ghi trạng thái lỗi: ${(err as Error).message}`);
    }
  }

  private async clear(): Promise<void> {
    try {
      await fs.unlink(statePath());
    } catch {
      // Không có file thì thôi.
    }
  }
}
