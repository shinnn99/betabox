import os from "node:os";
import { createHash } from "node:crypto";
import { AGENT_VERSION } from "./version";

/**
 * Bản tự khai gửi kèm mỗi nhịp tim (bản 0.13.0, kế hoạch VAN-HANH-NHIEU-KHO
 * đợt 7, phần 4.1).
 *
 * AGENT KHAI BÁO, CLOUD PHÁN XÉT. Ở đây KHÔNG có ngưỡng nào, không có câu
 * "lỗi" nào — chỉ sự thật: bản nào, camera nào đang ghi, đoạn cuối lúc nào,
 * ổ còn bao nhiêu, hàng đợi, lần đọc QR cuối. Cloud biết tổ chức này khai
 * mấy camera, ngưỡng bao nhiêu, và quyết định cái gì là sự cố. Đổi ngưỡng là
 * sửa cloud, không phải phát hành agent.
 *
 * Định dạng khớp `parseSelfReport` phía cloud (src/lib/warehouse/self-report.ts).
 * Hàm thuần — người gọi (nhịp tim) gom số liệu rồi truyền vào.
 */

/**
 * Khả năng bản này có. Cloud bật tính năng THEO KHẢ NĂNG, không theo số
 * phiên bản.
 *
 *   adaptive_clip_bitrate: bộ ghép hạ bitrate cho clip dài, và clip vượt
 *     ngưỡng tải lên được nén lại một lần cho vừa (compose/bitrate.ts,
 *     compose/fit-to-size.ts). Cloud chỉ mở cửa sổ 310s cho kiện hoàn khi
 *     thấy khả năng này.
 *   collect_diagnostics: nhận lệnh thu chẩn đoán từ xa.
 */
export const CAPABILITIES = ["adaptive_clip_bitrate", "collect_diagnostics"] as const;

export interface SelfReportInputs {
  uptimeSeconds: number;
  cameras: Array<{
    cameraId: string;
    recording: boolean;
    lastSegmentAt: Date | null;
    badFramesLastHour: number | null;
  }>;
  disk: {
    freeBytes: number;
    totalBytes: number;
    bytesPerRecordingHour: number | null;
    /** Thư mục ghi hình chiếm bao nhiêu. null = lượt này chưa đo. */
    recordingBytes?: number | null;
  } | null;
  scansPending: number | null;
  lastQrSuccessAt: Date | null;
  configFingerprint: string | null;
}

export function buildSelfReport(input: SelfReportInputs): Record<string, unknown> {
  return {
    version: AGENT_VERSION,
    uptime_s: Math.round(input.uptimeSeconds),
    os: `${os.type()} ${os.release()}`,
    ffmpeg: null,
    // Khoá camera là camera_id — cloud khớp đúng từng camera đã khai.
    cameras: input.cameras.map((c) => ({
      code: c.cameraId,
      recording: c.recording,
      last_segment_at: c.lastSegmentAt ? c.lastSegmentAt.toISOString() : null,
      bad_frames_last_hour: c.badFramesLastHour,
    })),
    disk: input.disk
      ? {
          free_bytes: input.disk.freeBytes,
          total_bytes: input.disk.totalBytes,
          // Agent ghi LIÊN TỤC (camera không tắt theo ca), nên tốc độ đầy ổ
          // một ngày = tốc độ mỗi giờ ghi × 24. Nếu sau này có kho chỉ ghi
          // trong ca, số này thành cận trên — ngày còn lại thành cận dưới,
          // tức là báo sớm chứ không báo muộn.
          bytes_per_day:
            input.disk.bytesPerRecordingHour && input.disk.bytesPerRecordingHour > 0
              ? Math.round(input.disk.bytesPerRecordingHour * 24)
              : null,
          // Riêng phần video chiếm, tách khỏi "đã dùng" của TOÀN ổ. Hai con số
          // trả lời hai câu khác nhau: toàn ổ cho cảnh báo sắp đầy (ffmpeg chết
          // bất kể ai làm đầy), còn số này cho câu "video của tôi chiếm bao
          // nhiêu". null = chưa đo được, KHÔNG phải 0.
          recording_bytes: input.disk.recordingBytes ?? null,
        }
      : null,
    // Clip chờ cắt / chờ tải lên: agent không có hàng đợi riêng — lệnh cắt
    // nằm ở cloud (`agent_commands`), tải lên chạy ngay trong lệnh cắt. Cloud
    // tự đếm; agent khai `null` chứ không bịa số.
    queues: {
      scans_pending: input.scansPending,
      clips_pending: null,
      uploads_pending: null,
    },
    last_qr_success_at: input.lastQrSuccessAt ? input.lastQrSuccessAt.toISOString() : null,
    config_fingerprint: input.configFingerprint,
    capabilities: [...CAPABILITIES],
  };
}

const SECRET_KEY = /secret|password|token|credential|key/i;

/**
 * Dấu vân tay cấu hình đang chạy — đổi là biết máy kho đã nhận cấu hình mới.
 * BỎ mọi khoá có dáng bí mật: dấu vân tay đi lên cloud, không được mang theo
 * (kể cả dạng băm) thứ đoán ngược được.
 */
export function configFingerprint(config: Record<string, unknown>): string {
  const safe = Object.keys(config)
    .filter((k) => !SECRET_KEY.test(k))
    .sort()
    .map((k) => [k, config[k]]);
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex").slice(0, 16);
}
