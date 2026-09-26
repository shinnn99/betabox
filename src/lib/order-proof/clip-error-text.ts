/**
 * Câu lỗi cắt / tải clip bằng TIẾNG VIỆT cho người dùng — không bao giờ lộ
 * mã lỗi kỹ thuật (chủ dự án chốt 26/09/2026: "lỗi này trả ra tiếng việt thôi
 * nhé đừng có trả ra hàm báo lỗi", ảnh: "proof_clip_too_large: 96.6MB v…").
 *
 * Chuỗi GỐC vẫn giữ nguyên trong `order_proof_clips.error_message` — cần cho
 * chẩn đoán. Hàm này chỉ dùng ở chỗ trả ra giao diện (danh sách video, route
 * /watch, hook trình duyệt). Gọi hai lần vẫn ra cùng kết quả.
 *
 * Nguồn chuỗi (kiểm kê 26/09/2026): agent gửi qua `clip-cut-result` /
 * `command-result` (mã + chi tiết tiếng Anh, đuôi ffmpeg, lỗi Node), route
 * /watch ghi câu tiếng Việt, `stale-pending.ts` ghi mã mồ côi.
 *
 * Luật, theo thứ tự:
 *   1. Lỗi thô nhận ra được ở BẤT CỨ ĐÂU trong chuỗi (ổ đầy, máy kho bận,
 *      mất mạng) → câu riêng — cụ thể hơn câu của mã bọc ngoài.
 *   2. Chuỗi mở đầu bằng mã (`abc_def:`, `abc_def[kind]:`, hoặc chỉ `abc_def`)
 *      → câu của mã đó, kèm việc cần làm. Mã chưa biết → câu chung.
 *   3. Câu tiếng Việt kèm đuôi kỹ thuật ("Chi tiết: <ffmpeg>", "[tag]") →
 *      bỏ đuôi.
 *   4. Câu đã là tiếng Việt → giữ nguyên (các câu giao diện đang nhận diện
 *      như "Video đã quá hạn lưu trữ…", "Không có video…" không được đổi).
 *   5. Còn lại (tiếng Anh) → câu chung.
 *
 * Hàm thuần, dùng được ở cả máy chủ lẫn trình duyệt.
 */

export const CLIP_ERROR_GENERIC = "Cắt video không thành công. Bấm Thử lại để cắt lại.";

const DISK_FULL = "Ổ đĩa máy kho đã đầy nên không cắt được video. Cần dọn ổ đĩa máy kho rồi bấm Thử lại.";
const AGENT_BUSY = "Máy kho đang bận cắt video khác. Bấm Thử lại sau ít phút.";
const NETWORK = "Máy kho mất kết nối mạng giữa chừng. Bấm Thử lại khi mạng ổn định.";
const FFMPEG = "Máy kho không tạo được file video. Bấm Thử lại; nếu vẫn lỗi, báo kỹ thuật kiểm tra máy kho.";
const NO_CUTTER = "Máy kho không chạy được bộ cắt video. Báo kỹ thuật kiểm tra máy kho.";

const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/** Nhận ra theo nội dung, ở bất cứ đâu trong chuỗi (luật 1). */
const RAW_ANYWHERE: Array<[RegExp, string]> = [
  [/ENOSPC|no space left on device/i, DISK_FULL],
  [/gate_busy_race/, AGENT_BUSY],
];

/** Nhận ra theo đầu chuỗi — lỗi thô không có mã. */
const RAW_START: Array<[RegExp, string]> = [
  [/^(fetch failed|this operation was aborted)/i, NETWORK],
  [/^spawn failed/i, NO_CUTTER],
  [/^ffmpeg exit/i, FFMPEG],
  // Agent: "Không tạo được file clip. Chi tiết: <3 dòng cuối stderr ffmpeg>".
  [/^Không tạo được file clip/, FFMPEG],
];

/** "96.6" → "96,6" — số kiểu Việt Nam. */
const vnNumber = (s: string) => s.replace(".", ",");

const isNetworkDetail = (detail: string) => /fetch failed|operation was aborted|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(detail);

const CODE_TEXT: Record<string, (detail: string) => string> = {
  proof_clip_too_large: (detail) => {
    // Agent: "96.6MB vượt trần upload 90.0MB (clip 305s, ...)".
    const m = /([\d.]+)MB vượt trần upload ([\d.]+)MB/.exec(detail);
    const sizes = m ? ` (${vnNumber(m[1])} MB, giới hạn ${vnNumber(m[2])} MB)` : "";
    return `Video của đơn này quá dung lượng để tải lên${sizes}. Bấm Thử lại để cắt lại — máy kho sẽ ghép và nén lại cho vừa.`;
  },
  segments_missing_on_disk: () =>
    "Không tìm thấy đoạn video trên máy kho — có thể đã bị dọn theo hạn lưu trữ, hoặc ổ đĩa máy kho gặp lỗi.",
  // Giữ đúng đầu câu "Video đã quá hạn lưu trữ" — danh sách video nhận diện
  // đầu câu này để hiện nhãn "Quá hạn lưu trữ" thay cho "Lỗi".
  // Agent: "video đã quá hạn lưu trữ (giữ 30 ngày)" hoặc "(segment hàng hoàn
  // giữ 7 ngày)".
  clip_expired_retention: (detail) => {
    const days = /giữ (\d+) ngày/.exec(detail)?.[1];
    if (!days) return "Video đã quá hạn lưu trữ nên không cắt lại được.";
    const kept = detail.includes("hàng hoàn") ? "video hàng hoàn giữ" : "giữ";
    return `Video đã quá hạn lưu trữ (${kept} ${days} ngày) nên không cắt lại được.`;
  },
  compose_failed: (detail) =>
    /has no segments/i.test(detail)
      ? "Một góc camera không có video trong khoảng thời gian của đơn nên không ghép được video hai góc. Kiểm tra camera đó có đang ghi hình không, rồi bấm Thử lại."
      : "Máy kho ghép video hai góc không thành công. Bấm Thử lại để cắt lại.",
  unsupported_output_codec: () =>
    "Camera ghi ở định dạng trình duyệt không phát được. Kiểm cài đặt mã hoá của camera (cần H.264).",
  signed_url_fetch_failed: (detail) =>
    isNetworkDetail(detail) ? NETWORK : "Máy kho chưa xin được chỗ để tải video lên. Bấm Thử lại.",
  read_tmp_failed: () => "Máy kho không đọc lại được file video vừa cắt. Bấm Thử lại.",
  // Kho lưu trữ từ chối vì file quá lớn (413 "Payload too large") không phải
  // chuyện mạng — nói đúng như proof_clip_too_large.
  upload_put_failed: (detail) =>
    /\b413\b|payload too large/i.test(detail)
      ? "Video của đơn này quá dung lượng để tải lên. Bấm Thử lại để cắt lại — máy kho sẽ ghép và nén lại cho vừa."
      : "Tải video lên không thành công — mạng của kho chậm hoặc bị ngắt. Bấm Thử lại khi mạng ổn định.",
  notify_complete_failed: (detail) =>
    isNetworkDetail(detail) ? NETWORK : "Video đã tải lên nhưng máy kho chưa báo hoàn tất được. Bấm Thử lại.",
  enqueue_cut_failed: () => "Không gửi được yêu cầu cắt video tới máy kho. Bấm Thử lại.",
  cut_orphan_no_active_command: () =>
    "Máy kho không báo lại kết quả cắt video (có thể máy kho vừa khởi động lại). Bấm Thử lại để cắt lại.",
  signed_url_failed: (detail) =>
    /bucket_(expired|missing)/.test(detail)
      ? "Video trên cloud đã được dọn theo hạn lưu. Bấm Thử lại để máy kho cắt lại."
      : "Chưa lấy được đường xem video. Bấm Thử lại.",
  regeneration_failed: () => "Tạo lại video không thành công — video cũ vẫn xem được. Bấm Tạo lại để thử lần nữa.",
  cut_failed: () => CLIP_ERROR_GENERIC,
  no_camera_for_event: () => "Đơn không gắn camera bằng chứng nên không có video.",
  packing_event_not_found: () => "Không tìm thấy đơn này.",
  packing_event_id_invalid: () => "Mã đơn không hợp lệ.",
  cross_org_access_denied: () => "Bạn không có quyền xem video của đơn này.",
  forbidden: () => "Bạn không có quyền xem video của đơn này.",
  unauthenticated: () => "Phiên đăng nhập đã hết — hãy đăng nhập lại.",
  agent_offline: () => "Máy kho đang mất kết nối — video sẽ cắt được khi máy kho kết nối lại.",
};

/**
 * Tách `abc_def: chi tiết`, `abc_def[timeout]: chi tiết`, hoặc chỉ `abc_def`
 * thành mã + chi tiết. Đầu chuỗi (trước dấu ":" đầu tiên) phải là MỘT từ
 * thường không dấu — câu tiếng Việt hay "spawn failed: …" không lọt vào.
 */
function splitCode(text: string): { code: string; detail: string } | null {
  const colon = text.indexOf(":");
  const head = (colon >= 0 ? text.slice(0, colon) : text).trim();
  const m = /^([a-z][a-z0-9_]*)(?:\[[\w-]*\])?$/.exec(head);
  if (!m) return null;
  return { code: m[1], detail: colon >= 0 ? text.slice(colon + 1).trim() : "" };
}

/** Đuôi kỹ thuật dính sau câu tiếng Việt: " [reconcile-write-failed]". */
const TRAILING_TAG = / ?\[[\w-]+\]$/;

export function clipErrorText(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return CLIP_ERROR_GENERIC;

  for (const [re, sentence] of RAW_ANYWHERE) if (re.test(text)) return sentence;

  const coded = splitCode(text);
  if (coded) {
    // Chỉ khoá của bảng — "constructor"… không được rơi vào hàm của Object.
    // (Không dùng Object.hasOwn: trình duyệt cũ ở kho chưa có.)
    const known = Object.prototype.hasOwnProperty.call(CODE_TEXT, coded.code);
    return known ? CODE_TEXT[coded.code](coded.detail) : CLIP_ERROR_GENERIC;
  }

  for (const [re, sentence] of RAW_START) if (re.test(text)) return sentence;

  const clean = text.replace(TRAILING_TAG, "").trim();
  // Đã là câu tiếng Việt → giữ nguyên.
  if (clean && VIETNAMESE_LETTER.test(clean)) return clean;
  // Câu kỹ thuật (tiếng Anh, đuôi lỗi ffmpeg...) → không lộ ra.
  return CLIP_ERROR_GENERIC;
}

/** Như `clipErrorText`, nhưng không có lỗi thì trả null (ô cảnh báo ẩn). */
export function clipErrorTextOrNull(raw: string | null | undefined): string | null {
  return raw?.trim() ? clipErrorText(raw) : null;
}

/**
 * Câu cho 409 của "Thử lại" (`/watch/retry`): server không gửi được lệnh cắt.
 * Có câu lý do (đơn đang đóng, lượt quét khi chưa mở ca…) thì hiện đúng câu
 * đó; chỉ `agent_offline` — không kèm câu — mới là "kho offline".
 *
 * Trước 26/09/2026 mọi 409 khác "đơn đang đóng" đều báo nhầm "Kho đang
 * offline", kể cả lượt quét khi chưa mở ca — đẩy người dùng đi kiểm mạng.
 */
export function retryConflictText(body: { error?: string; message?: string } | null): string {
  if (body?.error === "order_still_open") {
    return clipErrorText(body.message ?? "Đơn đang được đóng gói, chưa cắt được clip đầy đủ.");
  }
  if (body?.error !== "agent_offline" && body?.message) return clipErrorText(body.message);
  return "Kho đang offline, thử lại sau khi có kết nối.";
}
