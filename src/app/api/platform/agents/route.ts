import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { buildFleetViewRow, loadFleetRows } from "@/lib/warehouse/fleet";
import { LATEST_AGENT_VERSION } from "@/lib/warehouse/self-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/platform/agents — Đội agent: mọi máy kho một màn hình (kế hoạch
// VAN-HANH-NHIEU-KHO, đợt 7). Chỉ đọc.
//
// Sự cố mở của một máy = sự cố trong sổ gắn với chính agent đó, hoặc với
// một camera của nó.
// ============================================================================
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  let fleet: Awaited<ReturnType<typeof loadFleetRows>>;
  try {
    fleet = await loadFleetRows(admin);
  } catch (err) {
    return NextResponse.json({ error: "db_error", message: (err as Error).message }, { status: 500 });
  }

  const [orgsRes, camsRes, incRes] = await Promise.all([
    admin.from("organizations").select("id, name"),
    admin.from("cameras").select("id, camera_code, agent_id").eq("status", "active"),
    // Sổ chưa có (chưa chạy migration đợt 3) thì coi như 0 — trang vẫn chạy.
    admin
      .from("warehouse_incidents")
      .select("entity_id, severity")
      .in("status", ["open", "acknowledged"]),
  ]);

  const orgName = new Map((orgsRes.data ?? []).map((o) => [o.id as string, o.name as string]));
  const camsByAgent = new Map<string, Array<{ id: string; code: string | null }>>();
  for (const c of camsRes.data ?? []) {
    if (!c.agent_id) continue;
    const list = camsByAgent.get(c.agent_id as string) ?? [];
    list.push({ id: c.id as string, code: (c.camera_code as string | null) ?? null });
    camsByAgent.set(c.agent_id as string, list);
  }
  const incidents = (incRes.error ? [] : incRes.data ?? []) as Array<{ entity_id: string | null; severity: string }>;

  const rows = fleet.rows.map((r) => {
    const cams = camsByAgent.get(r.id) ?? [];
    const keys = new Set([r.id, ...cams.map((c) => c.id)]);
    const mine = incidents.filter((i) => i.entity_id && keys.has(i.entity_id));
    return buildFleetViewRow(r, {
      orgName: orgName.get(r.organization_id) ?? "—",
      declaredCameras: cams,
      openIncidents: {
        crit: mine.filter((i) => i.severity === "crit").length,
        warn: mine.filter((i) => i.severity === "warn").length,
      },
    });
  });

  return NextResponse.json({
    latestVersion: LATEST_AGENT_VERSION,
    selfReportAvailable: fleet.selfReportAvailable,
    incidentsAvailable: !incRes.error,
    agents: rows,
  });
}
