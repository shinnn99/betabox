import type { ReactNode } from "react";

// Dashboard pages đều dùng session Supabase (useSession, cameras cookies).
// Next 16 mặc định cố prerender shell client component tại build time,
// mà Supabase client throw khi thiếu runtime env → build fail. force-dynamic
// ở layout skip prerender cho mọi page dưới /dashboard, chuyển sang SSR-only.
export const dynamic = "force-dynamic";

export default function DashboardRouteLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
