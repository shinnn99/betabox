import "server-only";

import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StationOption {
  id: string;
  code: string;
  name: string;
}

/** Bàn đang hoạt động của tổ chức — lựa chọn "Bàn phụ trách" trên trang Người dùng. */
export async function listAssignableStations(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<StationOption[]> {
  const { data } = await admin
    .from("packing_stations")
    .select("id, code, name")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("code");
  return (data ?? []) as StationOption[];
}

/**
 * Đọc `station_id` từ body tạo/sửa người dùng.
 *
 * - không gửi → `undefined` (không đổi);
 * - `null` / chuỗi rỗng → `null` (bỏ gán);
 * - UUID → phải là bàn ĐANG HOẠT ĐỘNG của đúng tổ chức, nếu không thì trả lỗi.
 *   Không kiểm thì một id bàn của tổ chức khác lọt vào hồ sơ và luồng xem
 *   trực tiếp dùng nó làm phạm vi.
 */
export async function parseStationAssignment(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ value: string | null | undefined } | NextResponse> {
  if (!("station_id" in body) || body.station_id === undefined) return { value: undefined };
  const raw = body.station_id;
  if (raw === null || raw === "") return { value: null };
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return NextResponse.json(
      { error: "invalid_station", message: "Bàn phụ trách không hợp lệ." },
      { status: 400 },
    );
  }
  const { data } = await admin
    .from("packing_stations")
    .select("id")
    .eq("id", raw)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) {
    return NextResponse.json(
      {
        error: "invalid_station",
        message: "Bàn phụ trách không còn hoạt động hoặc không thuộc tổ chức này. Hãy chọn lại bàn.",
      },
      { status: 400 },
    );
  }
  return { value: raw };
}
