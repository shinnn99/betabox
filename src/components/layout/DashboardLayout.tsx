"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { PageHeaderRegistration } from "./PageHeaderContext";

interface Props {
  children: ReactNode;
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
  headerExtras?: ReactNode;
}

/**
 * Page-level compatibility wrapper. The persistent dashboard chrome now lives
 * in DashboardShell, mounted by app/dashboard/layout.tsx.
 */
export default function DashboardLayout(props: Props) {
  return <PageHeaderRegistration {...props} />;
}
