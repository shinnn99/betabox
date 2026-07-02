import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermission,
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("packing_station.view");
  if (isError(ctx)) return ctx;

  const warehouseId = req.nextUrl.searchParams.get("warehouse_id");
  const supabase = await createClient();
  let q = supabase
    .from("packing_stations")
    .select("id, code, name, warehouse_id, status, created_at, updated_at")
    .order("code");
  if (warehouseId) q = q.eq("warehouse_id", warehouseId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ stations: data ?? [] });
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("packing_station.create");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  const warehouseId = String(body.warehouse_id ?? "").trim();

  if (!code || !name || !warehouseId) {
    return NextResponse.json(
      { error: "validation", message: "Mã bàn, tên bàn và kho là bắt buộc." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Cross-org guard: warehouse must belong to the caller's org.
  const { data: wh } = await admin
    .from("warehouses")
    .select("id")
    .eq("id", warehouseId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!wh) {
    return NextResponse.json(
      { error: "warehouse_not_found", message: "Kho không thuộc tổ chức này." },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from("packing_stations")
    .insert({
      organization_id: ctx.organizationId,
      warehouse_id: warehouseId,
      code,
      name,
    })
    .select("id, code, name, warehouse_id, status, created_at, updated_at")
    .single();

  if (error) {
    const msg =
      (error as { code?: string }).code === "23505"
        ? "Mã bàn đã tồn tại trong kho này."
        : error.message;
    return NextResponse.json({ error: error.code ?? "insert_failed", message: msg }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "packing_station.create",
    targetType: "packing_station",
    targetId: data.id,
    metadata: { code, name, warehouse_id: warehouseId },
  });

  return NextResponse.json({ station: data }, { status: 201 });
}
