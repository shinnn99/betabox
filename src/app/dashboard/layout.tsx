import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentRenderOrgInfo } from "@/lib/platform/current-org-server";
import { checkPlatformAdmin } from "@/lib/platform/admin-check";
import { createClient } from "@/lib/supabase/server";
import ImpersonateBanner from "@/components/platform/ImpersonateBanner";
import ImpersonateWatcher from "@/components/platform/ImpersonateWatcher";

// Next 16 mặc định cố prerender shell client component tại build time,
// mà Supabase client throw khi thiếu runtime env → build fail. force-dynamic
// ở layout skip prerender cho mọi page dưới /dashboard, chuyển sang SSR-only.
export const dynamic = "force-dynamic";

// Server-side render org đang xem (từ cookie impersonate hoặc JWT).
// Nhúng data-render-org-id vào wrapper div → client wrapper apiFetch đọc
// gửi kèm x-render-org-id cho POST/PUT/DELETE (vế 4 chống ghi-nhầm).
//
// Banner đỏ đọc org name server-side mỗi request → không state cache, không
// nói dối. Watcher client-side đường 3 (poll cookie → reload nếu đổi).
export default async function DashboardRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  const orgInfo = await getCurrentRenderOrgInfo();

  // Platform admin gõ nhầm cửa: /dashboard là màn hình của TENANT, mà tài
  // khoản platform cố ý không thuộc org nào. Trước đây họ rơi vào đây và
  // nhận banner đỏ "User chưa được gán organization" — đúng về mặt bảo mật
  // (fail-closed, không thấy dữ liệu org nào) nhưng đọc như hệ thống hỏng.
  //
  // Vì sao lỗ này lâu nay không lộ: platform admin gần như luôn tới
  // /dashboard THÔNG QUA impersonate (11 phiên trong platform_audit_log),
  // lúc đó đã có org nên nhánh này không chạm tới. Vào thẳng, không
  // impersonate, mới thấy.
  //
  // Chỉ kiểm platform khi KHÔNG có org. Tenant thường luôn có org nên không
  // tốn thêm một query nào — đừng đảo thứ tự hai nhánh này.
  //
  // Không sợ vòng lặp: /platform đá người-không-phải-platform-admin về
  // /login (usePlatformSession), không đá về /dashboard.
  if (!orgInfo) {
    const supabase = await createClient();
    const { data: claimsData } = await supabase.auth.getClaims();
    const userId = claimsData?.claims?.sub as string | undefined;
    if (userId && (await checkPlatformAdmin(userId))) {
      redirect("/platform");
    }
    // Không phải platform admin mà vẫn không có org → để nguyên cho guard
    // báo "chưa được gán organization". Đó là ca cấu hình sai tài khoản
    // tenant, cần người sửa dữ liệu chứ không phải chuyển hướng đi chỗ khác.
  }

  const orgId = orgInfo?.orgId ?? "";

  return (
    <div
      data-render-org-id={orgId}
      // Cờ server-render để DashboardLayout (client) biết có đang impersonate
      // hay không mà KHÔNG phải poll endpoint. Đổi impersonate luôn kéo theo
      // full reload (ImpersonateWatcher đường 3), nên giá trị nhúng ở đây
      // không bao giờ cũ hơn màn hình đang hiển thị.
      data-impersonating={orgInfo?.isImpersonating ? "1" : "0"}
      className="contents"
    >
      {orgInfo?.isImpersonating && (
        <>
          <ImpersonateBanner orgName={orgInfo.orgName} />
          <ImpersonateWatcher renderOrgId={orgId} />
        </>
      )}
      {children}
    </div>
  );
}
