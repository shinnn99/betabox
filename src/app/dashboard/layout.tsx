import type { ReactNode } from "react";
import { getCurrentRenderOrgInfo } from "@/lib/platform/current-org-server";
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
