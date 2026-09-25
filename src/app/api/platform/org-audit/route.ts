import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { resolveTargetNamesAdmin } from "@/lib/audit-view/resolve-names";
import { targetKey } from "@/lib/audit-view/target-key";

/**
 * GET /api/platform/org-audit — nhật ký thao tác BÊN TRONG các kho, gộp mọi
 * tổ chức về một chỗ cho quản trị nền tảng.
 *
 * KHÁC `/api/platform/audit`: route kia đọc `platform_audit_log` (thao tác
 * CỦA quản trị nền tảng — impersonate, tạo/khoá tổ chức). Route này đọc
 * `audit_logs` (thao tác của người trong kho — xoá camera, sửa nhân viên).
 * Hai bảng khác nhau, hai trang khác nhau.
 *
 * Vì sao dùng admin client: platform admin KHÔNG có `organization_id` trong
 * JWT nên RLS của `audit_logs` trả 0 dòng (cọc A3). Xem xuyên kho là đúng
 * việc của trang này — nhưng vì thế mọi lối vào phải qua
 * `requirePlatformRole`, và khi lọc theo một kho thì filter phải áp ở
 * TRUY VẤN, không lọc ở trình duyệt.
 *
 * Query params:
 *   * limit (mặc định 200, tối đa 500)
 *   * org_id — lọc đúng một tổ chức; bỏ trống = mọi tổ chức
 */

interface AuditRow {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  organization_name_snapshot: string | null;
}

export async function GET(req: Request) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 200);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
  const orgId = url.searchParams.get("org_id");

  const admin = createAdminClient();

  let query = admin
    .from("audit_logs")
    .select(
      "id, organization_id, actor_user_id, actor_email, action, target_type, target_id, metadata, created_at, organization_name_snapshot",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  // Lọc ở truy vấn chứ không ở trình duyệt: lọc phía client vẫn gửi dữ liệu
  // mọi kho xuống máy người dùng, và làm hỏng luôn ý nghĩa của `limit`
  // (200 dòng mới nhất của MỌI kho, lọc xong còn vài dòng của kho cần xem).
  if (orgId && orgId !== "all") {
    query = query.eq("organization_id", orgId);
  }

  const [rowsRes, orgsRes] = await Promise.all([
    query,
    admin.from("organizations").select("id, name").order("name"),
  ]);

  if (rowsRes.error) {
    return NextResponse.json({ error: rowsRes.error.message }, { status: 500 });
  }

  const rows = (rowsRes.data ?? []) as AuditRow[];
  const orgNames = new Map<string, string>();
  for (const o of orgsRes.data ?? []) {
    orgNames.set(o.id as string, o.name as string);
  }

  // Tra tên đối tượng. Truyền cả organization_id để resolver KHÔNG lấy nhầm
  // tên của kho khác khi hai kho trùng id đối tượng (không xảy ra với uuid,
  // nhưng giữ ràng buộc để lỡ sau này có bảng dùng khoá khác thì vẫn đúng).
  const names = await resolveTargetNamesAdmin(admin, rows);

  const logs = rows.map((row) => {
    const key = targetKey(row);
    return {
      ...row,
      target_name: key ? names.get(key) ?? null : null,
      // Tên kho: ưu tiên tên hiện tại, lùi về ảnh chụp lúc ghi log (tổ chức
      // đã bị xoá thì chỉ còn ảnh chụp — xem migration 20260707160000).
      organization_name:
        (row.organization_id ? orgNames.get(row.organization_id) : null) ??
        row.organization_name_snapshot ??
        null,
    };
  });

  const organizations = [...orgNames.entries()].map(([id, name]) => ({
    id,
    name,
  }));

  return NextResponse.json({ logs, organizations });
}
