import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";
import { audit } from "@/lib/audit";
import { issueAndStoreStaffQr } from "@/lib/qr";

type StaffStatus = "active" | "inactive" | "on_leave";
const VALID_STATUS: StaffStatus[] = ["active", "inactive", "on_leave"];

export async function GET() {
  const ctx = await requirePermission("staff.view");
  if (isError(ctx)) return ctx;

  type StaffRow = {
    id: string;
    staff_code: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    status: StaffStatus;
    user_id: string | null;
    note: string | null;
    created_at: string;
  };

  const scoped = await getScopedClient(ctx);
  const { data: staffRaw, error } = await scoped
    .select<StaffRow>(
      "staff_profiles",
      "id, staff_code, full_name, phone, email, status, user_id, note, created_at",
    )
    .order("staff_code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const staff = (staffRaw ?? []) as StaffRow[];
  const ids = staff.map((s) => s.id);
  let assignments: Array<{
    staff_id: string;
    warehouse_id: string;
    is_primary: boolean;
    warehouses: { code: string; name: string } | { code: string; name: string }[] | null;
  }> = [];
  let qrPrefix: Map<string, string> = new Map();
  let qrPayload: Map<string, string> = new Map();

  type QrRow = {
    staff_id: string;
    token_prefix: string;
    payload: string | null;
    issued_at: string;
  };

  if (ids.length > 0) {
    const { data: a } = await scoped
      .select("staff_warehouse_assignments", "staff_id, warehouse_id, is_primary, warehouses(code, name)")
      .in("staff_id", ids)
      .is("unassigned_at", null);
    assignments = (a ?? []) as typeof assignments;

    const { data: qrRaw } = await scoped
      .select<QrRow>(
        "staff_qr_credentials",
        "staff_id, token_prefix, payload, issued_at",
      )
      .in("staff_id", ids)
      .eq("status", "active");
    const qr = (qrRaw ?? []) as QrRow[];
    qrPrefix = new Map(qr.map((r) => [r.staff_id, r.token_prefix]));
    qrPayload = new Map(
      qr
        .filter((r): r is QrRow & { payload: string } => !!r.payload)
        .map((r) => [r.staff_id, r.payload]),
    );
  }

  const result = staff.map((s) => {
    const a = assignments
      .filter((x) => x.staff_id === s.id)
      .map((x) => {
        const w = Array.isArray(x.warehouses) ? x.warehouses[0] : x.warehouses;
        return {
          warehouse_id: x.warehouse_id,
          code: w?.code ?? "",
          name: w?.name ?? "",
          is_primary: x.is_primary,
        };
      });
    return {
      ...s,
      warehouses: a,
      qr_active_prefix: qrPrefix.get(s.id) ?? null,
      qr_payload: qrPayload.get(s.id) ?? null,
    };
  });

  return NextResponse.json({ staff: result });
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("staff.create");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const staffCode = String(body.staff_code ?? "").trim().toUpperCase();
  const fullName = String(body.full_name ?? "").trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const status: StaffStatus = VALID_STATUS.includes(body.status) ? body.status : "active";
  const note = body.note ? String(body.note).trim() : null;
  const warehouseIds: string[] = Array.isArray(body.warehouse_ids) ? body.warehouse_ids : [];
  const primaryWarehouseId: string | null = body.primary_warehouse_id ?? null;

  if (!staffCode || !fullName) {
    return NextResponse.json(
      { error: "validation", message: "Mã nhân viên và họ tên là bắt buộc." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: staff, error: createErr } = await admin
    .from("staff_profiles")
    .insert({
      organization_id: ctx.organizationId,
      staff_code: staffCode,
      full_name: fullName,
      phone,
      email,
      status,
      note,
    })
    .select("id")
    .single();
  if (createErr || !staff) {
    return NextResponse.json({ error: createErr?.message ?? "create_failed" }, { status: 400 });
  }

  if (warehouseIds.length > 0) {
    const rows = warehouseIds.map((wid) => ({
      organization_id: ctx.organizationId,
      staff_id: staff.id,
      warehouse_id: wid,
      is_primary: wid === primaryWarehouseId,
    }));
    const { error: assignErr } = await admin
      .from("staff_warehouse_assignments")
      .insert(rows);
    if (assignErr) {
      console.warn("[staff.create] assignment failed:", assignErr.message);
    }
  }

  let qrTokenPrefix: string | null = null;
  try {
    const issued = await issueAndStoreStaffQr(ctx.organizationId, staff.id, ctx.userId);
    qrTokenPrefix = issued.tokenPrefix;
  } catch (e) {
    console.warn("[staff.create] auto-issue QR failed:", (e as Error).message);
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.create",
    targetType: "staff",
    targetId: staff.id,
    metadata: { staff_code: staffCode, full_name: fullName, warehouseIds, qr_token_prefix: qrTokenPrefix },
  });

  return NextResponse.json({ id: staff.id }, { status: 201 });
}
