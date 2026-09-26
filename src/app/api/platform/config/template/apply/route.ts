import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { readPlatformTemplate } from "@/lib/config/template-store";
import { planBlankFill, planIsEmpty, type BlankFillPlan } from "@/lib/config/template";
import { errorMessage } from "@/lib/system/job-log";

export const runtime = "nodejs";

// ============================================================================
// POST /api/platform/config/template/apply  body: { orgIds: string[], dryRun?: boolean }
// — "Điền mẫu vào ô trống" cho các tổ chức được chọn (kế hoạch
// VAN-HANH-NHIEU-KHO, đợt 6, phần 4.7).
//
// CHỈ điền ô đang TRỐNG. Ô đã đặt — kể cả đặt lệch mẫu — không bao giờ bị
// đụng. `dryRun` trả kế hoạch mà không ghi, để người bấm xem trước.
// GATE platform_owner. Mỗi tổ chức một dòng audit với đúng các ô đã điền.
// ============================================================================

const MAX_ORGS = 100;

export async function POST(req: Request) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const body = (await req.json().catch(() => null)) as { orgIds?: unknown; dryRun?: unknown } | null;
  const orgIds = Array.isArray(body?.orgIds)
    ? [...new Set(body.orgIds.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];
  if (orgIds.length === 0 || orgIds.length > MAX_ORGS) {
    return NextResponse.json(
      { error: "validation", message: `orgIds phải là danh sách 1–${MAX_ORGS} id tổ chức.` },
      { status: 400 },
    );
  }
  const dryRun = body?.dryRun === true;

  const admin = createAdminClient();
  const read = await readPlatformTemplate(admin, { fresh: true });

  const [orgsRes, whRes] = await Promise.all([
    admin.from("organizations").select("id, name, retention_days, return_retention_days").in("id", orgIds),
    admin
      .from("warehouses")
      .select("id, code, organization_id, packing_timing_config, session_fallback_seconds")
      .in("organization_id", orgIds),
  ]);
  if (orgsRes.error) return NextResponse.json({ error: "db_error", message: orgsRes.error.message }, { status: 500 });
  if (whRes.error) return NextResponse.json({ error: "db_error", message: whRes.error.message }, { status: 500 });

  const results: Array<{ orgId: string; name: string; plan: BlankFillPlan; applied: boolean; error?: string }> = [];
  for (const org of orgsRes.data ?? []) {
    const whs = (whRes.data ?? []).filter((w) => w.organization_id === org.id);
    const plan = planBlankFill(org, whs, read.template);
    if (dryRun || planIsEmpty(plan)) {
      results.push({ orgId: org.id, name: org.name, plan, applied: false });
      continue;
    }
    try {
      await applyPlan(admin, org.id, plan, whs);
      await logPlatformAudit({
        actorUserId: ctx.userId,
        actorEmail: ctx.email,
        impersonatingOrgId: null,
        action: "platform.config_template.apply",
        targetType: "organization",
        targetId: org.id,
        metadata: { filled: plan, template_from_table: read.fromTable },
        actorRoleSnapshot: ctx.platformRole,
        targetOrganizationNameSnapshot: org.name,
      });
      results.push({ orgId: org.id, name: org.name, plan, applied: true });
    } catch (err) {
      results.push({ orgId: org.id, name: org.name, plan, applied: false, error: errorMessage(err) });
    }
  }

  const missing = orgIds.filter((id) => !(orgsRes.data ?? []).some((o) => o.id === id));
  return NextResponse.json({ ok: true, dryRun, templateFromTable: read.fromTable, results, missing });
}

/**
 * Ghi đúng các ô trống.
 *
 * Cột tổ chức: UPDATE có thêm điều kiện "ô vẫn trống" — ai vừa đặt tay giữa
 * lúc tính kế hoạch và lúc ghi thì không bị ghi đè. JSON cấu hình kho thì
 * không đặt điều kiện theo từng khoá được: gộp vào bản vừa đọc, cửa sổ chồng
 * lấn chỉ vài trăm mili-giây — chấp nhận, như route sửa kho của tenant.
 */
async function applyPlan(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  plan: BlankFillPlan,
  whs: Array<{ id: string; packing_timing_config: unknown }>,
): Promise<void> {
  for (const [key, value] of Object.entries(plan.org)) {
    const { error } = await admin
      .from("organizations")
      .update({ [key]: value })
      .eq("id", orgId)
      .is(key, null);
    if (error) throw new Error(`${key}: ${error.message}`);
  }
  for (const w of plan.warehouses) {
    const cur = whs.find((x) => x.id === w.id);
    const curCfg = (cur?.packing_timing_config as Record<string, unknown> | null) ?? {};
    const update: Record<string, unknown> = {};
    if (Object.keys(w.timing).length > 0) update.packing_timing_config = { ...curCfg, ...w.timing };
    if (w.session_fallback_seconds !== undefined) update.session_fallback_seconds = w.session_fallback_seconds;
    const { error } = await admin
      .from("warehouses")
      .update(update)
      .eq("id", w.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(`kho ${w.code ?? w.id}: ${error.message}`);
  }
}
