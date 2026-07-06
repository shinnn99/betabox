/**
 * HIGH-11: khi user đổi field kết nối camera (IP/port/path/user/password),
 * codec_detected snapshot cũ không còn tin được — camera có thể trỏ sang
 * stream khác (main vs sub, H.264 vs HEVC). Không invalidate → agent cắt
 * HEVC nhưng codec_detected nói H.264 → codec guard fail → clip failed
 * hàng loạt cho đến khi ops probe tay.
 *
 * Pure helper (không dính "server-only") để test được không cần Supabase.
 * Chỉ chứa logic decide + payload — không I/O.
 */

/**
 * Các field ảnh hưởng RTSP stream. Đổi bất kỳ 1 field → coi như stream
 * source có thể khác → invalidate codec.
 *
 * KHÔNG bao gồm: name, location, status — thuần metadata, không đụng stream.
 * KHÔNG bao gồm: camera_code — mã hiển thị/định danh, không đổi stream URL
 * (agent build URL từ ip/port/path/user/pass, không từ code).
 */
export const CONNECTION_FIELDS = [
  "ip",
  "rtsp_port",
  "rtsp_path",
  "username",
  "password",
] as const;

export type ConnectionField = (typeof CONNECTION_FIELDS)[number];

export interface DetectConnectionChangeInput {
  ip?: string;
  rtsp_port?: number;
  rtsp_path?: string;
  username?: string;
  password?: string | null;
}

/**
 * Có bất kỳ connection field nào được truyền vào (kể cả undefined→string
 * empty)? Ta không so với giá trị cũ vì lý do "user gửi kèm cùng giá trị
 * cũ" hiếm và không đáng risk (probe lại là an toàn — invalidate false
 * positive chỉ tốn 1 lượt probe).
 *
 * Trả về danh sách field detected để log rõ.
 */
export function detectConnectionChange(
  input: DetectConnectionChangeInput,
): ConnectionField[] {
  const changed: ConnectionField[] = [];
  for (const f of CONNECTION_FIELDS) {
    if ((input as Record<string, unknown>)[f] !== undefined) {
      changed.push(f);
    }
  }
  return changed;
}

/**
 * Trả về patch để merge vào UPDATE payload — reset codec state.
 * Atomic với các field kết nối trong cùng 1 UPDATE query.
 */
export function buildCodecInvalidationPatch(): Record<string, null> {
  return {
    codec_detected: null,
    codec_warning: null,
    codec_probed_at: null,
    codec_probe_error: null,
  };
}
