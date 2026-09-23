import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolveVietnamDayScope, vietnamTodayUtcRange } from "@/lib/warehouse/time-range";
import { parseControlCard } from "@/lib/station/control-cards";
import type { ActivityCategory, ActivityItem, ActivityPayload } from "@/lib/warehouse/live/activity";
import type { Issue } from "@/lib/warehouse/live/issues";

/**
 * Khối "Cần xử lý" và "Nhật ký" của màn hình Giám sát hoàn hàng.
 *
 * Trả về ĐÚNG hình dạng của bản đóng hàng (`Issue`, `ActivityPayload`) để
 * một khung giao diện vẽ được cả hai — chỉ khác nội dung. Xem
 * plans/active/HOAN-HANG-giao-dien-giam-sat-bang-chung.md.
 */

type Admin = ReturnType<typeof createAdminClient>;

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export const INSPECTION_LABEL: Record<string, string> = {
  ok: "Hàng ổn",
  damaged: "Hỏng",
  missing: "Thiếu",
  swapped: "Tráo",
  unchecked: "Chưa kiểm",
};

/** Cùng một câu cho cả hai luồng — xem activity.ts. */
export const NO_SESSION_NOTE = "Quét khi chưa có người vào ca";

export const RETURN_KIND_LABEL: Record<string, string> = {
  rts: "Giao thất bại",
  customer_return: "Khách trả",
  suspect: "Quét ở bàn đóng hàng",
};

export const CLOSE_REASON_LABEL: Record<string, string> = {
  result_card: "thẻ kết quả",
  end_card: "thẻ KẾT THÚC",
  next_scan: "quét kiện kế tiếp",
  mode_switch: "đổi chế độ bàn",
  shift_closed: "đóng ca",
  timeout: "tự dừng sau 5 phút",
  suspect: "lưới an toàn",
  manual: "nhập tay",
};

// ---------------------------------------------------------------------------
// Phân loại một kiện hoàn thành một dòng nhật ký — hàm thuần, có test.
// ---------------------------------------------------------------------------

export interface ReturnEventForActivity {
  status: string;
  timing_status: string | null;
  return_kind: string | null;
  inspection_result: string | null;
  close_reason: string | null;
}

export function classifyReturnEvent(e: ReturnEventForActivity): {
  kind: ActivityItem["kind"];
  category: ActivityCategory;
  note: string | null;
} {
  // Hàng hoàn dùng ĐÚNG bộ chữ của đóng hàng (chủ dự án chốt 23/09/2026):
  // cùng một việc thì cùng một chữ. Hoàn là hoàn, không ghi vì sao hoàn.
  //
  // Ghi chú LUÔN rỗng: cột Loại đã nói đủ (Hợp lệ / Trùng / Chưa mở ca /
  // Hàng hoàn), nên cột Ghi chú chỉ dành cho cảnh báo video nặng — đúng như
  // trang Giám sát đóng hàng.
  if (e.status === "duplicated_return") {
    return { kind: "waybill_duplicated", category: "warning", note: null };
  }
  if (e.status === "return_suspect") {
    return { kind: "waybill_return_suspect", category: "warning", note: null };
  }
  if (e.status === "no_active_session") {
    return { kind: "waybill_no_session", category: "error", note: null };
  }
  return { kind: "waybill_valid", category: "ok", note: null };
}

/** Nhãn một thẻ điều khiển cho cột nội dung của nhật ký. */
export function describeControlCard(rawValue: string): string {
  const card = parseControlCard(rawValue);
  if (!card) return "Thẻ điều khiển không hợp lệ";
  if (card.kind === "mode") {
    return card.mode === "return" ? "Thẻ NHẬN HOÀN" : "Thẻ ĐÓNG HÀNG";
  }
  if (card.kind === "end") return "Thẻ KẾT THÚC";
  return `Thẻ kết quả: ${INSPECTION_LABEL[card.result] ?? card.result}`;
}

// ---------------------------------------------------------------------------
// Cần xử lý
// ---------------------------------------------------------------------------

function remainingText(deadlineIso: string): string {
  const ms = Date.parse(deadlineIso) - Date.now();
  if (ms <= 0) return "đã tới hạn";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `còn ${Math.floor(hours / 24)} ngày`;
  if (hours >= 1) return `còn ${hours} giờ`;
  return `còn ${Math.max(1, Math.floor(ms / 60_000))} phút`;
}

/**
 * Việc cần làm của luồng hoàn:
 *   - Hồ sơ mở (kiện có vấn đề chưa khiếu nại) — mọi ngày, hạn gần nhất trước.
 *   - Kiện bị lưới an toàn bắt ở bàn đóng hàng hôm nay.
 *   - Quét lại kiện đã ghi hoàn hôm nay.
 */
export async function buildReturnIssues(
  admin: Admin,
  orgId: string,
  limit: number,
): Promise<{ issues: Issue[] }> {
  const { startIso, endIso } = vietnamTodayUtcRange();

  const [claimsRes, todayRes] = await Promise.all([
    admin
      .from("return_claims")
      .select(
        `id, deadline_at, created_at,
         packing_events!inner ( id, raw_event_id, waybill_code, scanned_at, scanner_device_code,
           inspection_result,
           staff_profiles ( staff_code, full_name ),
           packing_stations ( code, name ) )`,
      )
      .eq("organization_id", orgId)
      .eq("status", "open")
      .order("deadline_at", { ascending: true })
      .limit(limit),
    admin
      .from("packing_events")
      .select(
        `id, raw_event_id, status, waybill_code, scanned_at, scanner_device_code,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name )`,
      )
      .eq("organization_id", orgId)
      .eq("event_kind", "return")
      .in("status", ["return_suspect", "duplicated_return"])
      .gte("scanned_at", startIso)
      .lt("scanned_at", endIso)
      .order("scanned_at", { ascending: false })
      .limit(limit),
  ]);

  const issues: Issue[] = [];

  for (const c of claimsRes.data ?? []) {
    const pe = pickOne(c.packing_events);
    if (!pe) continue;
    const staff = pickOne(pe.staff_profiles);
    const station = pickOne(pe.packing_stations);
    const result = pe.inspection_result
      ? (INSPECTION_LABEL[pe.inspection_result] ?? pe.inspection_result)
      : "Chưa kiểm";
    issues.push({
      id: `claim-${c.id}`,
      kind: "claim_open",
      title: `Kiện hoàn: ${result}`,
      message: `${pe.waybill_code ?? "—"} · ${remainingText(c.deadline_at)} để khiếu nại với sàn`,
      occurred_at: pe.scanned_at,
      scanner_device_code: pe.scanner_device_code,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: pe.waybill_code,
      raw_event_id: pe.raw_event_id,
    });
  }

  for (const p of todayRes.data ?? []) {
    const staff = pickOne(p.staff_profiles);
    const station = pickOne(p.packing_stations);
    const suspect = p.status === "return_suspect";
    issues.push({
      id: p.id,
      kind: suspect ? "return_suspect" : "duplicated_return",
      title: suspect ? "Mã đã gửi đi quay lại bàn đóng hàng" : "Quét lại kiện đã ghi hoàn",
      message: suspect
        ? `${p.waybill_code} quét ở ${station?.name ?? p.scanner_device_code} — có thể là hàng hoàn, không tính đơn`
        : `${p.waybill_code} đã ghi hoàn trước đó`,
      occurred_at: p.scanned_at,
      scanner_device_code: p.scanner_device_code,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: p.waybill_code,
      raw_event_id: p.raw_event_id,
    });
  }

  return { issues: issues.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Nhật ký
// ---------------------------------------------------------------------------

/**
 * Nhật ký một ngày VN của luồng hoàn: mỗi kiện hoàn một dòng, cộng các lượt
 * quét thẻ điều khiển. Cùng hình dạng với nhật ký đóng hàng.
 *
 * Throw khi query gốc lỗi — overview hạ xuống `activity_error`, y như bản
 * đóng hàng.
 */
export async function buildReturnActivity(
  admin: Admin,
  orgId: string,
  dateParam: string | null,
  limit: number,
): Promise<ActivityPayload> {
  const day = resolveVietnamDayScope(dateParam);

  const [eventsRes, eventsCount, cardsRes, cardsCount] = await Promise.all([
    admin
      .from("packing_events")
      .select(
        `id, raw_event_id, status, waybill_code, scanned_at, scanner_device_code,
         timing_status, return_kind, inspection_result, close_reason,
         work_started_at, work_ended_at, work_duration_seconds,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name ),
         warehouses ( code )`,
      )
      .eq("organization_id", orgId)
      .eq("event_kind", "return")
      .gte("scanned_at", day.startIso)
      .lt("scanned_at", day.endIso)
      .order("scanned_at", { ascending: false })
      .limit(limit),
    admin
      .from("packing_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_kind", "return")
      .gte("scanned_at", day.startIso)
      .lt("scanned_at", day.endIso),
    admin
      .from("warehouse_scan_raw_events")
      .select("id, scanner_device_code, raw_value, scanned_at, received_at")
      .eq("organization_id", orgId)
      .eq("scan_type", "control")
      .gte("scanned_at", day.startIso)
      .lt("scanned_at", day.endIso)
      .order("received_at", { ascending: false })
      .limit(limit),
    admin
      .from("warehouse_scan_raw_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("scan_type", "control")
      .gte("scanned_at", day.startIso)
      .lt("scanned_at", day.endIso),
  ]);

  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (cardsRes.error) throw new Error(cardsRes.error.message);

  const items: ActivityItem[] = [];

  for (const e of eventsRes.data ?? []) {
    const staff = pickOne(e.staff_profiles);
    const station = pickOne(e.packing_stations);
    const wh = pickOne(e.warehouses);
    const { kind, category, note } = classifyReturnEvent(e);
    items.push({
      id: e.id,
      raw_event_id: e.raw_event_id,
      kind,
      category,
      occurred_at: e.scanned_at,
      scanner_device_code: e.scanner_device_code,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      warehouse_code: wh?.code ?? null,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: e.waybill_code,
      note,
      work_started_at: e.work_started_at,
      work_ended_at: e.work_ended_at,
      work_duration_seconds: e.work_duration_seconds,
      timing_status: e.timing_status,
    });
  }

  // Thẻ điều khiển: bàn nào, lúc nào. Suy bàn qua cùng resolver của nhật ký
  // đóng hàng để không sinh hai luật "máy quét này thuộc bàn nào".
  const cards = cardsRes.data ?? [];
  const stationByRaw = new Map<string, { code: string; name: string }>();
  if (cards.length > 0) {
    const resolved = await Promise.all(
      cards.map(async (r) => {
        const { data } = await admin
          .rpc("resolve_scanner_at", {
            p_organization_id: orgId,
            p_device_code: r.scanner_device_code,
            p_at: r.scanned_at,
          })
          .maybeSingle<{ station_id: string }>();
        return { rawId: r.id, stationId: data?.station_id ?? null };
      }),
    );
    const ids = Array.from(new Set(resolved.map((x) => x.stationId).filter((x): x is string => !!x)));
    if (ids.length > 0) {
      const { data: stations } = await admin
        .from("packing_stations")
        .select("id, code, name")
        .in("id", ids);
      const byId = new Map((stations ?? []).map((s) => [s.id as string, s] as const));
      for (const r of resolved) {
        const st = r.stationId ? byId.get(r.stationId) : undefined;
        if (st) stationByRaw.set(r.rawId, { code: st.code as string, name: st.name as string });
      }
    }
  }

  for (const r of cards) {
    const st = stationByRaw.get(r.id) ?? null;
    items.push({
      id: r.id,
      raw_event_id: r.id,
      kind: "control_card",
      category: "info",
      occurred_at: r.received_at ?? r.scanned_at,
      scanner_device_code: r.scanner_device_code,
      station_code: st?.code ?? null,
      station_name: st?.name ?? null,
      warehouse_code: null,
      staff_code: null,
      staff_name: null,
      waybill_code: describeControlCard(r.raw_value),
      note: null,
      work_started_at: null,
      work_ended_at: null,
      work_duration_seconds: null,
      timing_status: null,
    });
  }

  items.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  return {
    activity: items.slice(0, limit),
    date: day.dateKey,
    invalid_date: day.invalidDate,
    limit,
    total: (eventsCount.count ?? 0) + (cardsCount.count ?? 0),
  };
}
