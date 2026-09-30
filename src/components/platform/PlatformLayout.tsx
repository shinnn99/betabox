"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { PageHeaderRegistration } from "@/components/layout/PageHeaderContext";

interface Props {
  children: ReactNode;
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
}

/**
 * Page-level compatibility wrapper. The persistent platform chrome now lives
 * in PlatformShell, mounted by app/platform/layout.tsx.
 */
export default function PlatformLayout(props: Props) {
  return <PageHeaderRegistration {...props} />;
}
