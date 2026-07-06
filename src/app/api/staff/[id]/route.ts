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

    // Sync xuống user_profiles nếu staff đã link với user.
    // user_profiles.id = auth.users.id — global scope. Filter theo target.user_id
    // đã đủ (không cần org filter vì staff đã verify org).
    if (target.user_id) {
      const userUpdate: Record<string, unknown> = {};
      if ("full_name" in update) userUpdate.full_name = update.full_name;
      if ("phone" in update) userUpdate.phone = update.phone;
      if (Object.keys(userUpdate).length > 0) {
        const { error: upErr } = await admin
          .from("user_profiles")
          .update(userUpdate)
          .eq("id", target.user_id);
        if (upErr) {
          // Sync xuống user_profiles là best-effort — staff đã update ổn.
          // Log để có trace, không rollback nghiệp vụ chính.
          console.error(
            `[staff.update] user_profiles sync failed staff_id=${id} user_id=${target.user_id} code=${upErr.code ?? "?"} message=${upErr.message}`,
          );
        }
      }
    }
  }

  // Cập nhật assignment nếu gửi kèm.
  //
  // HIGH-9: warehouse_ids từ body — PHẢI verify tất cả thuộc org
  // trước khi insert, reject toàn bộ payload nếu có 1 ID sai.
  // Dedupe input để tránh insert duplicate (constraint sẽ error, nhưng
  // vẫn nên dedupe upstream cho message rõ hơn).
  if (Array.isArray(body.warehouse_ids)) {
    const rawIds = (body.warehouse_ids as unknown[]).filter(
      (x) => typeof x === "string" && x.length > 0,
    ) as string[];
    // Dedupe input.
    const newIds = Array.from(new Set(rawIds));
    const primary = typeof body.primary_warehouse_id === "string"
      ? body.primary_warehouse_id
      : null;

    // Verify: mọi warehouse_id thuộc org (defense: reject toàn bộ nếu 1 sai).
    if (newIds.length > 0) {
      const { data: allowed, error: whErr } = await admin
        .from("warehouses")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .in("id", newIds);
      if (whErr) {
        return NextResponse.json(
          { error: "warehouse_lookup_failed", message: whErr.message },
          { status: 500 },
        );
      }
      const allowedSet = new Set((allowed ?? []).map((r) => r.id));
      const badIds = newIds.filter((wid) => !allowedSet.has(wid));
      if (badIds.length > 0) {
        // KHÔNG log badIds (có thể là guess của attacker, không cần echo).
        return NextResponse.json(
          {
            error: "warehouse_not_in_org",
            message: "Một hoặc nhiều kho không thuộc tổ chức.",
          },
          { status: 400 },
        );
      }
      // Nếu primary được set nhưng không nằm trong newIds → coi như null.
      // (Không rò lỗi: đây là chỉnh chuẩn dữ liệu, không phải attack.)
    }

    const { data: current, error: curErr } = await admin
      .from("staff_warehouse_assignments")
      .select("id, warehouse_id, is_primary")
      .eq("staff_id", id)
      .eq("organization_id", ctx.organizationId)
      .is("unassigned_at", null);
    if (curErr) {
      return NextResponse.json(
        { error: "assignment_lookup_failed", message: curErr.message },
        { status: 500 },
      );
    }

    const currentIds = new Set((current ?? []).map((x) => x.warehouse_id));
    const newSet = new Set(newIds);

    const toRemove = (current ?? []).filter((x) => !newSet.has(x.warehouse_id));
    const toAdd = newIds.filter((wid) => !currentIds.has(wid));

    if (toRemove.length > 0) {
      const { error: remErr } = await admin
        .from("staff_warehouse_assignments")
        .update({ unassigned_at: new Date().toISOString() })
        .eq("organization_id", ctx.organizationId)
        .in(
          "id",
          toRemove.map((x) => x.id),
        );
      if (remErr) {
        return NextResponse.json(
          { error: "assignment_remove_failed", message: remErr.message },
          { status: 500 },
        );
      }
    }
    if (toAdd.length > 0) {
      const { error: insErr } = await admin
        .from("staff_warehouse_assignments")
        .insert(
          toAdd.map((wid) => ({
            organization_id: ctx.organizationId,
            staff_id: id,
            warehouse_id: wid,
            is_primary: wid === primary,
          })),
        );
      if (insErr) {
        return NextResponse.json(
          { error: "assignment_insert_failed", message: insErr.message },
          { status: 500 },
        );
      }
    }
    // Cập nhật is_primary cho assignment còn lại.
    for (const wid of newIds) {
      const { error: primErr } = await admin
        .from("staff_warehouse_assignments")
        .update({ is_primary: wid === primary })
        .eq("staff_id", id)
        .eq("warehouse_id", wid)
        .eq("organization_id", ctx.organizationId)
        .is("unassigned_at", null);
      if (primErr) {
        return NextResponse.json(
          { error: "assignment_primary_failed", message: primErr.message },
          { status: 500 },
        );
      }
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
