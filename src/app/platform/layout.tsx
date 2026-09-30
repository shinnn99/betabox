import type { ReactNode } from "react";
import PlatformShell from "@/components/platform/PlatformShell";

// force-dynamic để skip prerender (giống dashboard tenant — cần runtime env).
export const dynamic = "force-dynamic";

export default function PlatformRouteLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
