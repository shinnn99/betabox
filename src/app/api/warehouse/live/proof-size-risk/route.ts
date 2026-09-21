import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { resolveVietnamDayScope } from "@/lib/warehouse/time-range";
import { buildProofSizeRisks, parseProofRiskLimit } from "@/lib/order-proof/proof-size-risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cảnh báo sớm: đơn nào sẽ sinh proof clip vượt trần upload.
 *
 * Tách khỏi /live/activity có chủ đích. Activity poll 3 giây; ước lượng
 * này cần query segment theo từng đơn nên đặt chung sẽ nhân chi phí lên
 * mỗi nhịp. Đơn đã đóng thì kích thước clip không đổi nữa, nên poll
 * chậm (khuyến nghị 60s) là đủ tươi.
 *
 * KHÔNG lọc riêng finalized_by_checkout. Hôm nay phần lớn rủi ro nằm ở
 * đó, nhưng nếu mai bitrate camera tăng lên 3 Mbps thì clip capped 190s
 * cũng vượt trần. Helper không được biết "checkout" là gì — bộ lọc
 * nghiệp vụ để ở phía hiển thị.
 *
 * Logic ước lượng nằm ở src/lib/order-proof/proof-size-risk.ts (dùng chung
 * với trang Giám sát hoàn hàng). Route này chỉ ước lượng ĐƠN ĐI.
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  // Cùng ngày với bảng hoạt động. Không bó ngày ở đây thì khi người dùng
  // xem lại hôm qua, badge biến mất và tab "Cần xử lý" đếm thiếu đơn
  // proof quá nặng — im lặng báo sót, đúng thứ tab đó sinh ra để chặn.
  const day = resolveVietnamDayScope(req.nextUrl.searchParams.get("date"));
  try {
    const result = await buildProofSizeRisks({
      admin: createAdminClient(),
      orgId: ctx.organizationId,
      day,
      limit: parseProofRiskLimit(req.nextUrl.searchParams.get("limit")),
      eventKind: "outbound",
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
