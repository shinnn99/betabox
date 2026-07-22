import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

const EDITABLE_FIELDS = [
  "name",
  "logo_url",
  "retention_days",
] as const;

// Retention hợp lệ: 7-365 ngày. Dưới 7 = mất bằng chứng ngay; trên 365 = ổ đầy
// vô ích (không sàn nào cho khiếu nại quá năm). DB CHECK constraint enforce
// cùng range — validate ở đây trả lỗi rõ tiếng Việt trước khi DB reject.
const RETENTION_MIN_DAYS = 7;
const RETENTION_MAX_DAYS = 365;

export async function GET() {
  const ctx = await requirePermission("organization.view");
  if (isError(ctx)) return ctx;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, slug, logo_url, status, retention_days, created_at, updated_at")
    .eq("id", ctx.organizationId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ organization: data });
}

export async function PATCH(req: Request) {
  const ctx = await requirePermissionStrict("organization.update");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const f of EDITABLE_FIELDS) {
    if (f in body) {
      const v = body[f];
      update[f] = typeof v === "string" ? v.trim() || null : v;
    }
  }

  if (typeof update.name === "string" && update.name.length === 0) {
    return NextResponse.json(
      { error: "validation", message: "Tên tổ chức không được rỗng." },
      { status: 400 }
    );
  }

  if ("retention_days" in update) {
    const v = update.retention_days;
    if (v === null) {
      // Cho phép null để clear cấu hình. Resolver sẽ trả nhãn trung tính,
      // cleanup script sẽ fail-loud → Hạnh biết chưa cấu hình.
    } else if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < RETENTION_MIN_DAYS ||
      v > RETENTION_MAX_DAYS
    ) {
      return NextResponse.json(
        {
          error: "validation",
          message: `retention_days phải là số nguyên trong khoảng ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} ngày (hoặc null để bỏ cấu hình).`,
        },
        { status: 400 }
      );
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .update(update)
    .eq("id", ctx.organizationId)
    .select("id, name, slug, logo_url, status, retention_days, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "organization.update",
    targetType: "organization",
    targetId: ctx.organizationId,
    metadata: { changes: update },
  });

  return NextResponse.json({ organization: data });
}
