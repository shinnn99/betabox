import type { ReactNode } from "react";

// force-dynamic để skip prerender (giống dashboard tenant — cần runtime env).
export const dynamic = "force-dynamic";

export default function PlatformRouteLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
