import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_STATUS = ["active", "inactive", "on_leave"] as const;

async function fetchStaff(id: string, orgId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("staff_profiles")
    .select("id, organization_id, staff_code, full_name, user_id")
    .eq("id", id)
    .single();
  if (!data || data.organization_id !== orgId) return null;
  return data;
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("staff.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const target = await fetchStaff(id, ctx.organizationId);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.full_name === "string") update.full_name = body.full_name.trim();
  if (typeof body.phone === "string" || body.phone === null) update.phone = body.phone;
  if (typeof body.email === "string" || body.email === null)
    update.email = body.email ? String(body.email).trim().toLowerCase() : null;
  if (typeof body.note === "string" || body.note === null) update.note = body.note;
  if (typeof body.status === "string") {
    if (!(VALID_STATUS as readonly string[]).includes(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    update.status = body.status;
  }

  const admin = createAdminClient();

  if (Object.keys(update).length > 0) {
    const { error } = await admin
      .from("staff_profiles")
      .update(update)
      .eq("id", id)
      .eq("organization_id", ctx.organizationId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Sync xuống user_profiles nếu staff đã link với user
    if (target.user_id) {
      const userUpdate: Record<string, unknown> = {};
      if ("full_name" in update) userUpdate.full_name = update.full_name;
      if ("phone" in update) userUpdate.phone = update.phone;
      if (Object.keys(userUpdate).length > 0) {
        await admin.from("user_profiles").update(userUpdate).eq("id", target.user_id);
      }
    }
  }

  // Cập nhật assignment nếu gửi kèm
  if (Array.isArray(body.warehouse_ids)) {
    const newIds = body.warehouse_ids as string[];
    const primary = body.primary_warehouse_id ?? null;

    const { data: current } = await admin
      .from("staff_warehouse_assignments")
      .select("id, warehouse_id, is_primary")
      .eq("staff_id", id)
      .is("unassigned_at", null);

    const currentIds = new Set((current ?? []).map((x) => x.warehouse_id));
    const newSet = new Set(newIds);

    const toRemove = (current ?? []).filter((x) => !newSet.has(x.warehouse_id));
    const toAdd = newIds.filter((wid) => !currentIds.has(wid));

    if (toRemove.length > 0) {
      await admin
        .from("staff_warehouse_assignments")
        .update({ unassigned_at: new Date().toISOString() })
        .in(
          "id",
          toRemove.map((x) => x.id)
        );
    }
    if (toAdd.length > 0) {
      await admin.from("staff_warehouse_assignments").insert(
        toAdd.map((wid) => ({
          organization_id: ctx.organizationId,
          staff_id: id,
          warehouse_id: wid,
          is_primary: wid === primary,
        }))
      );
    }
    // Cập nhật is_primary cho assignment còn lại
    for (const wid of newIds) {
      await admin
        .from("staff_warehouse_assignments")
        .update({ is_primary: wid === primary })
        .eq("staff_id", id)
        .eq("warehouse_id", wid)
        .is("unassigned_at", null);
    }
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.update",
    targetType: "staff",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("staff.delete");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const target = await fetchStaff(id, ctx.organizationId);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("staff_profiles")
    .delete()
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.delete",
    targetType: "staff",
    targetId: id,
    metadata: { staff_code: target.staff_code, full_name: target.full_name },
  });

  return NextResponse.json({ ok: true });
}
