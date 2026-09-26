/**
 * Đọc ba thông số thời gian của cửa sổ clip từ `packing_timing_config` của
 * kho. MỘT nơi duy nhất — hàm thuần, không đụng DB.
 *
 * Vì sao phải tách ra: trước 26/09/2026 có HAI nơi tự đọc, mỗi nơi một kiểu.
 *
 *   clip-resolver.ts     mặc định 10s, kẹp trần 120s   ← máy cắt clip thật
 *   proof-size-risk.ts   mặc định 10s, KHÔNG kẹp trần  ← cảnh báo dung lượng
 *
 * Đặt `video_pre_seconds = 300` thì clip thật cắt 120s mà cảnh báo "Proof có
 * nguy cơ vượt giới hạn" lại tính theo 300s — đúng kiểu lệch mà ghi chú đầu
 * `clip-window.ts` đã cảnh báo: *"Nếu mỗi nơi tự tính, UI sẽ báo một số còn
 * agent render ra số khác"*. Giờ cả hai và phép giải "Đặt / Thực dùng"
 * (`src/lib/config/effective.ts`) cùng gọi hàm này.
 *
 * ĐỌC CẤU HÌNH ĐÃ LƯU, không qua `resolve_packing_timing` của database — vì
 * máy cắt clip vốn đọc như vậy, và phép giải phải phản ánh đúng cái đang
 * chạy chứ không phải cái lẽ ra nên chạy.
 */

/**
 * Mặc định khi kho thiếu khoá.
 *
 * ⚠ LỆCH VỚI DATABASE ở `video_pre_seconds`: `packing_timing_default_config()`
 * trả **5**, còn ở đây là **10**. Kho tạo mới luôn có đủ khoá (cột mặc định
 * bằng hàm đó) nên hai kho đang chạy không bị ảnh hưởng — chỉ kho nào lưu
 * thiếu khoá mới rơi vào nhánh này. Chưa đồng bộ vì đổi con số là đổi
 * hành vi cắt clip; phép giải "Đặt / Thực dùng" hiện đúng con số 10 để thấy.
 */
export const FALLBACK_PRE = 10;
export const FALLBACK_BEFORE_NEXT = 2;
export const FALLBACK_DEFAULT_POST = 60;

/**
 * Trần chống gõ nhầm đơn vị — ai đó điền phút thay vì giây rồi cắt ra clip
 * dài một tiếng. Cố ý rộng tay: để bắt cấu hình sai rõ ràng, không phải để
 * áp chính sách nghiệp vụ.
 */
export const MAX_PRE = 120;
export const MAX_BEFORE_NEXT = 60;
export const MAX_DEFAULT_POST = 600;

export interface TimingTriple {
  pre: number;
  beforeNext: number;
  defaultPost: number;
}

export function readTimingConfig(cfg: unknown): TimingTriple {
  const out: TimingTriple = {
    pre: FALLBACK_PRE,
    beforeNext: FALLBACK_BEFORE_NEXT,
    defaultPost: FALLBACK_DEFAULT_POST,
  };
  if (!cfg || typeof cfg !== "object") return out;
  const c = cfg as Record<string, unknown>;
  const pre = Number(c.video_pre_seconds);
  const beforeNext = Number(c.video_before_next_seconds);
  const post = Number(c.video_default_post_seconds);
  // Kẹp mà im lặng thì câu hỏi "sao đặt 30 phút mà clip chỉ 10 phút?" không
  // ai lần ra — dòng warn là manh mối trỏ đúng dòng cấu hình sai.
  if (Number.isFinite(pre) && pre >= 0) {
    if (pre > MAX_PRE) {
      console.warn(
        `[timing-config] packing_timing_config.video_pre_seconds=${pre} ` +
          `vượt trần ${MAX_PRE}s — đang kẹp. Kiểm lại cấu hình kho.`,
      );
    }
    out.pre = Math.min(pre, MAX_PRE);
  }
  // before_next được phép bằng 0 (cắt đúng tới lượt quét kế).
  if (Number.isFinite(beforeNext) && beforeNext >= 0) {
    if (beforeNext > MAX_BEFORE_NEXT) {
      console.warn(
        `[timing-config] packing_timing_config.video_before_next_seconds=${beforeNext} ` +
          `vượt trần ${MAX_BEFORE_NEXT}s — đang kẹp. Kiểm lại cấu hình kho.`,
      );
    }
    out.beforeNext = Math.min(beforeNext, MAX_BEFORE_NEXT);
  }
  if (Number.isFinite(post) && post > 0) {
    if (post > MAX_DEFAULT_POST) {
      console.warn(
        `[timing-config] packing_timing_config.video_default_post_seconds=${post} ` +
          `vượt trần ${MAX_DEFAULT_POST}s — đang kẹp. Kiểm lại cấu hình kho.`,
      );
    }
    out.defaultPost = Math.min(post, MAX_DEFAULT_POST);
  }
  return out;
}
