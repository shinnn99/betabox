import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { readStorageHealth } from "@/lib/warehouse/storage-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/warehouse/storage — sức chứa bằng chứng của CHÍNH kho đang đăng nhập.
 *
 * Quyền `station_device.view` — cùng quyền với trang Máy trạm kho, vì đây là
 * câu hỏi về chính cái máy đó (chủ dự án chốt 02/10/2026).
 *
 * CÁCH LY TENANT: org lấy từ `ctx.organizationId` (do guard giải từ JWT /
 * cookie đóng giả), KHÔNG nhận org qua query param. Nhận qua param là mở
 * đường cho kho A gõ id kho B. Mọi truy vấn bên trong `readStorageHealth`
 * đều lọc đúng org này.
 */
export async function GET() {
  const ctx = await requirePermission("station_device.view");
  if (isError(ctx)) return ctx;

  try {
    const health = await readStorageHealth(createAdminClient(), ctx.organizationId);
    return NextResponse.json(health);
  } catch (err) {
    return NextResponse.json(
      { error: "db_error", message: err instanceof Error ? err.message : "Không đọc được." },
      { status: 500 },
    );
  }
}
