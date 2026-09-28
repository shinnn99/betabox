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

  const [orgsRes, camsRes, incRes, diagnosticsRes] = await Promise.all([
    admin.from("organizations").select("id, name"),
    admin.from("cameras").select("id, camera_code, agent_id").eq("status", "active"),
    // Sổ chưa có (chưa chạy migration đợt 3) thì coi như 0 — trang vẫn chạy.
    admin
      .from("warehouse_incidents")
      .select("entity_id, severity")
      .in("status", ["open", "acknowledged"]),
    admin
      .from("agent_commands")
      .select("id, agent_id, status, created_at, completed_at, payload")
      .eq("type", "collect_diagnostics")
      .order("created_at", { ascending: false })
      .limit(1000),
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
  const latestDiagnostic = new Map<
    string,
    {
      id: string;
      status: string;
      createdAt: string;
      completedAt: string | null;
      eventName: string | null;
      automatic: boolean;
    }
  >();
  for (const d of diagnosticsRes.error ? [] : diagnosticsRes.data ?? []) {
    const agentId = d.agent_id as string | null;
    if (!agentId || latestDiagnostic.has(agentId)) continue;
    const payload = d.payload && typeof d.payload === "object" ? (d.payload as Record<string, unknown>) : {};
    const trigger =
      payload.trigger && typeof payload.trigger === "object"
        ? (payload.trigger as Record<string, unknown>)
        : null;
    latestDiagnostic.set(agentId, {
      id: d.id as string,
      status: d.status as string,
      createdAt: d.created_at as string,
      completedAt: (d.completed_at as string | null) ?? null,
      eventName: typeof trigger?.event_name === "string" ? trigger.event_name : null,
      automatic: trigger?.source === "ui_event_failure",
    });
  }

  const rows = fleet.rows.map((r) => {
    const cams = camsByAgent.get(r.id) ?? [];
    const keys = new Set([r.id, ...cams.map((c) => c.id)]);
    const mine = incidents.filter((i) => i.entity_id && keys.has(i.entity_id));
    return {
      ...buildFleetViewRow(r, {
      orgName: orgName.get(r.organization_id) ?? "—",
      declaredCameras: cams,
      openIncidents: {
        crit: mine.filter((i) => i.severity === "crit").length,
        warn: mine.filter((i) => i.severity === "warn").length,
      },
      }),
      latestDiagnostic: latestDiagnostic.get(r.id) ?? null,
    };
  });

  return NextResponse.json({
    latestVersion: LATEST_AGENT_VERSION,
    selfReportAvailable: fleet.selfReportAvailable,
    incidentsAvailable: !incRes.error,
    agents: rows,
  });
}
