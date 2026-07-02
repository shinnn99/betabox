import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";

export const runtime = "nodejs";

// Series sản lượng cho card "Sản lượng đóng hàng theo giờ" trên dashboard.
// Tách thành route riêng để dropdown range có thể fetch lại mà không phải
// kéo cả overview (cameras, staff, alerts, …) — chi phí query khác hẳn.
//
// range:
//   today     → hourly 07h..19h theo business_date hôm nay
//   yesterday → hourly 07h..19h theo business_date hôm qua
//   7d        → daily 7 ngày gần nhất (bao gồm hôm nay)
//   30d       → daily 30 ngày gần nhất

type Range = "today" | "yesterday" | "7d" | "30d";

interface SeriesPoint {
  key: string;
  label: string;
  value: number;
}

interface ProductionResponse {
  range: Range;
  unit: "hour" | "day";
  series: SeriesPoint[];
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shortDateLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export async function GET(req: Request) {
  const ctx = await requirePermission("report.view");
  if (isError(ctx)) return ctx;

  const url = new URL(req.url);
  const rawRange = (url.searchParams.get("range") ?? "today") as Range;
  const range: Range = ["today", "yesterday", "7d", "30d"].includes(rawRange)
    ? rawRange
    : "today";

  const admin = createAdminClient();
  const today = todayUTC();

  const SHIFT_START = 7;
  const SHIFT_END = 19;

  if (range === "today" || range === "yesterday") {
    const businessDate = range === "today" ? today : addDays(today, -1);
    const { data, error } = await admin
      .from("packing_events")
      .select("status, scanned_at")
      .eq("organization_id", ctx.organizationId)
      .eq("business_date", businessDate)
      .eq("status", "valid");
    if (error) {
      return NextResponse.json(
        { error: "production_failed", message: error.message },
        { status: 500 },
      );
    }
    const buckets = new Array(24).fill(0) as number[];
    for (const ev of data ?? []) {
      if (!ev.scanned_at) continue;
      const h = new Date(ev.scanned_at as string).getHours();
      if (h >= 0 && h < 24) buckets[h] += 1;
    }
    const series: SeriesPoint[] = [];
    for (let h = SHIFT_START; h <= SHIFT_END; h += 1) {
      series.push({
        key: String(h),
        label: `${String(h).padStart(2, "0")}h`,
        value: buckets[h] ?? 0,
      });
    }
    const response: ProductionResponse = { range, unit: "hour", series };
    return NextResponse.json(response);
  }

  // 7d / 30d
  const days = range === "7d" ? 7 : 30;
  const fromDate = addDays(today, -(days - 1));
  const { data, error } = await admin
    .from("packing_events")
    .select("status, business_date")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "valid")
    .gte("business_date", fromDate)
    .lte("business_date", today);
  if (error) {
    return NextResponse.json(
      { error: "production_failed", message: error.message },
      { status: 500 },
    );
  }
  const byDate = new Map<string, number>();
  for (const ev of data ?? []) {
    const d = ev.business_date as string;
    byDate.set(d, (byDate.get(d) ?? 0) + 1);
  }
  const series: SeriesPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const iso = addDays(fromDate, i);
    series.push({
      key: iso,
      label: shortDateLabel(iso),
      value: byDate.get(iso) ?? 0,
    });
  }
  const response: ProductionResponse = { range, unit: "day", series };
  return NextResponse.json(response);
}
