import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermission,
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * List warehouse_agents for the current org plus their last-discovery
 * snapshot. The UI uses this for the device-pairing screen so a manager
 * can see "Agent X is currently seeing 3 ports".
 */
export async function GET() {
  const ctx = await requirePermission("station_device.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("warehouse_agents")
    .select(
      "id, code, name, status, last_seen_at, last_discovered_at, last_discovered_scanners",
    )
    .eq("organization_id", ctx.organizationId)
    .order("code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ agents: data ?? [] });
}

/**
 * POST — tạo warehouse_agent mới. Body:
 *   { code: "AGENT_KHO_XX_01", name: "Máy kho X" }
 * Backend sinh secret 32 bytes (64 hex chars), lưu plain vào DB (schema
 * hiện tại), trả về secret DUY NHẤT 1 LẦN trong response. Sau đó không
 * có API nào trả về secret plaintext — mất copy = phải reset.
 *
 * Code: chỉ chữ HOA, số, `_`, `-`. Unique global (partial index cũ).
 * Reason chọn plain lưu: schema hiện tại đã plain, đổi sang hash cần
 * migrate agent v0.3.0 (sign body theo hash). Chưa gấp — cọc kỹ thuật
 * "envelope encryption với KMS" đã ghi trong README warehouse-agent.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("station_device.create");
  if (isError(ctx)) return ctx;

  const body = (await req.json().catch(() => null)) as {
    code?: unknown;
    name?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!CODE_RE.test(code)) {
    return NextResponse.json(
      {
        error: "code_invalid",
        message:
          "Mã agent chỉ dùng chữ HOA, số, gạch dưới, gạch nối. Ví dụ: AGENT_KHO_HN_01.",
      },
      { status: 400 },
    );
  }
  if (name.length < 2 || name.length > 100) {
    return NextResponse.json(
      { error: "name_invalid", message: "Tên agent 2–100 ký tự." },
      { status: 400 },
    );
  }

  const secret = randomBytes(32).toString("hex");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("warehouse_agents")
    .insert({
      organization_id: ctx.organizationId,
      code,
      name,
      secret,
      status: "active",
    })
    .select("id, code, name, status, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "code_taken", message: "Mã agent đã tồn tại. Chọn mã khác." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "create_failed", message: error.message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse_agent.create",
    targetType: "warehouse_agent",
    targetId: data.id,
    metadata: { code, name },
  });

  return NextResponse.json(
    {
      agent: data,
      // Secret CHỈ trả lần này. Client hiển thị modal cảnh báo "copy ngay".
      secret,
    },
    { status: 201 },
  );
}
