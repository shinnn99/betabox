/**
 * Phép giải "Đặt / Thực dùng" — MỘT nơi trả lời câu hỏi "giá trị người ta
 * đặt có thật sự được dùng không".
 *
 * VÌ SAO CẦN: trước 26/09/2026 giao diện chỉ hiện MỘT con số — con số đã
 * đặt — và người đọc đương nhiên tưởng đó là con số đang chạy. Kiểm kê cho
 * thấy mỗi thông số có từ một đến ba nơi đọc, mỗi nơi tự tính mặc định và
 * tự kẹp theo kiểu riêng:
 *
 *   - `max_order_seconds`: ô nhập cho phép tới 3600, hệ thống chạy thật
 *     kẹp ở 180. Kho Betacom Demo đặt 600 mà không ai biết là vô tác dụng.
 *   - `video_pre_seconds`: database mặc định 5, máy cắt clip mặc định 10.
 *   - Bộ ước lượng dung lượng tự đọc lại cấu hình, cùng mặc định nhưng
 *     không kẹp trần như máy cắt clip.
 *
 * NGUYÊN TẮC DUY NHẤT CỦA FILE NÀY: không tự tính. Con số "thực dùng" phải
 * đến từ ĐÚNG hàm mà hệ thống chạy thật đang gọi — `readTimingConfig`,
 * `resolveOrderLimitSeconds`, `resolveReturnLimitSeconds`,
 * `resolveReturnRetentionDays`. Chép lại logic kẹp vào đây là thành nơi thứ
 * tư lệch nhau, đúng thứ file này sinh ra để dọn.
 *
 * Hàm thuần, không đụng DB — gọi được từ mục kiểm, từ API, từ test.
 */

import { MAX_CLIP_DURATION_SECONDS } from "@/lib/order-proof/clip-window";
import {
  FALLBACK_BEFORE_NEXT,
  FALLBACK_DEFAULT_POST,
  FALLBACK_PRE,
  MAX_BEFORE_NEXT,
  MAX_DEFAULT_POST,
  MAX_PRE,
  readTimingConfig,
} from "@/lib/order-proof/timing-config";
import {
  ORDER_MIN_LIMIT_SECONDS,
  RETURN_HARD_LIMIT_SECONDS,
  RETURN_MIN_LIMIT_SECONDS,
  resolveOrderLimitSeconds,
  resolveReturnLimitSeconds,
} from "@/lib/station/order-timeout";
import {
  DEFAULT_RETURN_RETENTION_DAYS,
  resolveReturnRetentionDays,
} from "@/lib/config/return-retention";

/**
 *   set       — đã đặt, và đang dùng đúng như đặt
 *   default   — chưa đặt, đang dùng mặc định
 *   clamped   — đã đặt, nhưng hệ thống dùng con số khác
 *   disabled  — chưa đặt, và vì thế tính năng KHÔNG chạy
 */
export type ParamSource = "set" | "default" | "clamped" | "disabled";

export interface EffectiveParam {
  key: string;
  label: string;
  unit: "ngày" | "giây";
  /** Giá trị đang lưu. `null` = ô để trống. */
  set: number | null;
  /** Giá trị hệ thống thật sự dùng. `null` = tính năng không chạy. */
  effective: number | null;
  source: ParamSource;
  /** Vì sao `effective` khác `set`. `null` khi `source = "set"`. */
  reason: string | null;
  /**
   * Hệ quả phía sau mà người đặt cần biết, dù con số tự nó không sai. Ví
   * dụ: kiện hoàn tự đóng sau 300 giây nhưng clip chỉ ghi được 175 giây đầu.
   */
  consequence: string | null;
}

export interface OrgConfigInput {
  retention_days: number | null;
  return_retention_days: number | null;
}

export interface WarehouseConfigInput {
  packing_timing_config: unknown;
  session_fallback_seconds: number | null;
}

/**
 * Phần đuôi của kiện hoàn / đơn không có video dài hơn ngần này mới đáng
 * nói. Đơn đi: trần 180s trừ đệm 5s còn 175s — hụt 5s cuối, không đáng
 * làm ồn. Kiện hoàn: hụt 125s — mất gần nửa việc kiểm hàng.
 */
const UNCOVERED_TAIL_NOTICE_SECONDS = 30;

/** Giá trị đang lưu trong JSON cấu hình kho, `null` nếu không có số nào. */
function storedNumber(cfg: unknown, key: string): number | null {
  if (!cfg || typeof cfg !== "object") return null;
  const n = Number((cfg as Record<string, unknown>)[key]);
  return Number.isFinite(n) ? n : null;
}

function param(
  base: Pick<EffectiveParam, "key" | "label" | "unit">,
  set: number | null,
  effective: number | null,
  source: ParamSource,
  reason: string | null,
  consequence: string | null = null,
): EffectiveParam {
  return { ...base, set, effective, source, reason, consequence };
}

// ============================================================================
// Cấp tổ chức
// ============================================================================

export function resolveOrgParams(
  input: OrgConfigInput,
  /**
   * Cấu hình của kho mà route `retention-plan` lấy làm chỗ dự phòng cho hạn
   * lưu hàng hoàn. Route lấy kho ĐẦU TIÊN — truyền đúng kho đó để hai bên
   * ra cùng một con số.
   */
  fallbackWarehouseCfg: unknown = null,
): EffectiveParam[] {
  // `undefined` (cột không được select, bản ghi thiếu trường) phải hiểu là
  // "để trống", không phải "đã đặt". Không chuẩn hoá thì ô trống bị đọc
  // thành "đặt giá trị ngoài khoảng" và báo nhầm là BỊ KẸP.
  const org = {
    retention_days: input.retention_days ?? null,
    return_retention_days: input.return_retention_days ?? null,
  };
  const out: EffectiveParam[] = [];

  // Thời gian lưu video — không có mặc định. Trống là agent không nhận hạn
  // lưu, và script dọn ổ máy kho fail-loud rồi KHÔNG chạy.
  {
    const base = { key: "retention_days", label: "Thời gian lưu video", unit: "ngày" as const };
    if (org.retention_days === null) {
      out.push(
        param(
          base,
          null,
          null,
          "disabled",
          "Chưa đặt — máy kho không nhận được hạn lưu, script dọn ổ đĩa sẽ không chạy.",
        ),
      );
    } else {
      out.push(param(base, org.retention_days, org.retention_days, "set", null));
    }
  }

  // Thời gian lưu video hàng hoàn — cùng hàm với route retention-plan.
  {
    const base = {
      key: "return_retention_days",
      label: "Thời gian lưu video hàng hoàn",
      unit: "ngày" as const,
    };
    const r = resolveReturnRetentionDays(org.return_retention_days, fallbackWarehouseCfg);
    if (r.source === "org") {
      out.push(param(base, org.return_retention_days, r.days, "set", null));
    } else if (r.source === "warehouse_legacy") {
      out.push(
        param(
          base,
          null,
          r.days,
          "default",
          `Chưa đặt ở tổ chức — đang dùng giá trị cũ trong cấu hình kho: ${r.days} ngày.`,
        ),
      );
    } else if (org.return_retention_days !== null) {
      out.push(
        param(
          base,
          org.return_retention_days,
          r.days,
          "clamped",
          `Giá trị ngoài khoảng 1–365 — đang dùng mặc định ${DEFAULT_RETURN_RETENTION_DAYS} ngày.`,
        ),
      );
    } else {
      out.push(
        param(
          base,
          null,
          r.days,
          "default",
          `Chưa đặt — đang dùng mặc định ${DEFAULT_RETURN_RETENTION_DAYS} ngày.`,
        ),
      );
    }
  }

  return out;
}

// ============================================================================
// Cấp kho
// ============================================================================

export function resolveWarehouseParams(
  wh: WarehouseConfigInput,
  /**
   * Trần clip đang áp của cả nền tảng — `clip_max_seconds` của mẫu (đợt 6).
   * Phải truyền đúng con số mà máy cắt clip đang dùng; không truyền = hằng
   * số cũ.
   */
  clipMaxSeconds: number = MAX_CLIP_DURATION_SECONDS,
  /**
   * Trần clip KIỆN HOÀN thực tế của tổ chức — 310s khi mọi agent của tổ chức
   * tự khai `adaptive_clip_bitrate` (đợt 7), còn lại bằng trần chung. Xem
   * `returnClipCapSeconds` trong clip-resolver.ts. Không truyền = trần chung.
   */
  returnClipSeconds: number = clipMaxSeconds,
): EffectiveParam[] {
  const cfg = wh.packing_timing_config;
  const timing = readTimingConfig(cfg);
  const out: EffectiveParam[] = [];

  // Thời gian tối đa một đơn — HAI tầng: nghiệp vụ (SQL, đánh dấu đơn bất
  // thường) dùng thẳng số đặt; video và tự dừng đơn kẹp ở trần kỹ thuật.
  // "Thực dùng" hiện tầng video, vì đó là tầng người đặt số quan tâm.
  {
    const base = {
      key: "max_order_seconds",
      label: "Thời gian tối đa một đơn",
      unit: "giây" as const,
    };
    const set = storedNumber(cfg, "max_order_seconds");
    const eff = resolveOrderLimitSeconds(cfg, clipMaxSeconds);
    const coverage = clipMaxSeconds - timing.pre;
    const consequence =
      eff - coverage > UNCOVERED_TAIL_NOTICE_SECONDS
        ? `Clip bằng chứng chỉ dài tối đa ${clipMaxSeconds}s kể cả đệm — ` +
          `${eff - coverage}s cuối của đơn dài nhất không có video.`
        : null;
    if (set === null) {
      out.push(param(base, null, eff, "default", `Chưa đặt — dùng mặc định ${eff}s.`, consequence));
    } else if (set <= 0) {
      out.push(
        param(base, set, eff, "clamped", `Giá trị không hợp lệ — dùng mặc định ${eff}s.`, consequence),
      );
    } else if (set > clipMaxSeconds) {
      out.push(
        param(
          base,
          set,
          eff,
          "clamped",
          `Kẹp ở trần kỹ thuật ${clipMaxSeconds}s của video và tự dừng đơn. ` +
            `${set}s chỉ còn dùng để đánh dấu đơn bất thường.`,
          consequence,
        ),
      );
    } else if (set < ORDER_MIN_LIMIT_SECONDS) {
      out.push(
        param(base, set, eff, "clamped", `Nâng lên sàn ${ORDER_MIN_LIMIT_SECONDS}s.`, consequence),
      );
    } else {
      out.push(param(base, set, eff, "set", null, consequence));
    }
  }

  // Ba thông số cửa sổ clip — cùng hàm với máy cắt clip.
  out.push(
    timingParam(
      { key: "video_pre_seconds", label: "Video lấy trước lúc quét", unit: "giây" },
      storedNumber(cfg, "video_pre_seconds"),
      timing.pre,
      { fallback: FALLBACK_PRE, max: MAX_PRE, allowZero: true },
    ),
    timingParam(
      {
        key: "video_before_next_seconds",
        label: "Cắt trước lượt quét kế",
        unit: "giây",
      },
      storedNumber(cfg, "video_before_next_seconds"),
      timing.beforeNext,
      { fallback: FALLBACK_BEFORE_NEXT, max: MAX_BEFORE_NEXT, allowZero: true },
    ),
    timingParam(
      {
        key: "video_default_post_seconds",
        label: "Video lấy sau khi chưa có quét kế",
        unit: "giây",
      },
      storedNumber(cfg, "video_default_post_seconds"),
      timing.defaultPost,
      { fallback: FALLBACK_DEFAULT_POST, max: MAX_DEFAULT_POST, allowZero: false },
    ),
  );

  // Gán lượt quét cho ca vừa kết thúc — cột riêng, SQL coalesce về 30.
  {
    const base = {
      key: "session_fallback_seconds",
      label: "Fallback session",
      unit: "giây" as const,
    };
    const set = wh.session_fallback_seconds ?? null;
    out.push(
      set === null
        ? param(base, null, 30, "default", "Chưa đặt — dùng mặc định 30s.")
        : param(base, set, set, "set", null),
    );
  }

  // Thời gian tối đa một kiện hoàn — tự đóng kiện. KHÁC đơn đi: hàm này chỉ
  // kẹp sàn, không kẹp trần. Hệ quả thật nằm ở clip: xem `consequence`.
  {
    const base = {
      key: "return_max_seconds",
      label: "Thời gian tối đa một kiện hoàn",
      unit: "giây" as const,
    };
    const set = storedNumber(cfg, "return_max_seconds");
    const eff = resolveReturnLimitSeconds(cfg);
    // Trần cuối cùng của clip-resolver cho kiện hoàn: trần chung (đo trên
    // production 26/09/2026: kiện hoàn 300s ra clip đúng 180s, lý do
    // `capped_at_max_duration`), trừ khi agent tự khai hạ được bitrate — lúc
    // đó 310s (đợt 7). Có test canh: ai sửa trần đó trong clip-resolver thì
    // phải sửa cả dòng này.
    const coverage = returnClipSeconds - timing.pre;
    const consequence =
      eff - coverage > UNCOVERED_TAIL_NOTICE_SECONDS
        ? `Kiện hoàn tự đóng sau ${eff}s nhưng clip bằng chứng chỉ ghi được ${coverage}s đầu — ` +
          `${eff - coverage}s cuối không có video.`
        : null;
    if (set === null) {
      out.push(
        param(base, null, eff, "default", `Chưa đặt — dùng mặc định ${RETURN_HARD_LIMIT_SECONDS}s.`, consequence),
      );
    } else if (set <= 0) {
      out.push(
        param(base, set, eff, "clamped", `Giá trị không hợp lệ — dùng mặc định ${eff}s.`, consequence),
      );
    } else if (set < RETURN_MIN_LIMIT_SECONDS) {
      out.push(
        param(base, set, eff, "clamped", `Nâng lên sàn ${RETURN_MIN_LIMIT_SECONDS}s.`, consequence),
      );
    } else {
      out.push(param(base, set, eff, "set", null, consequence));
    }
  }

  return out;
}

function timingParam(
  base: Pick<EffectiveParam, "key" | "label" | "unit">,
  set: number | null,
  effective: number,
  rule: { fallback: number; max: number; allowZero: boolean },
): EffectiveParam {
  if (set === null) {
    return param(base, null, effective, "default", `Chưa đặt — máy cắt clip dùng mặc định ${rule.fallback}s.`);
  }
  const valid = rule.allowZero ? set >= 0 : set > 0;
  if (!valid) {
    return param(base, set, effective, "clamped", `Giá trị không hợp lệ — dùng mặc định ${rule.fallback}s.`);
  }
  if (set > rule.max) {
    return param(base, set, effective, "clamped", `Kẹp ở trần ${rule.max}s chống gõ nhầm đơn vị.`);
  }
  return param(base, set, effective, "set", null);
}

/**
 * Dòng cấu hình có ô nào lệch khỏi "đặt và dùng đúng như đặt" không — bộ lọc
 * "chỉ dòng cần chú ý" của trang Cấu hình các kho.
 */
export function paramsNeedAttention(params: EffectiveParam[]): boolean {
  return params.some((p) => p.source !== "set" || p.consequence !== null);
}
