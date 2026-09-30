"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { LucideIcon } from "lucide-react";

export interface PageHeaderState {
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
  headerExtras?: ReactNode;
}

export const PageHeaderSetterContext = createContext<
  Dispatch<SetStateAction<PageHeaderState>> | null
>(null);

function sameHeader(a: PageHeaderState, b: PageHeaderState): boolean {
  return (
    a.pageTitle === b.pageTitle &&
    a.pageSubtitle === b.pageSubtitle &&
    a.pageIcon === b.pageIcon &&
    a.headerExtras === b.headerExtras
  );
}

/**
 * A page only publishes its header metadata. The route-level shell owns the
 * sidebar/navbar so those components stay mounted during client navigation.
 */
export function PageHeaderRegistration({
  children,
  pageTitle,
  pageSubtitle,
  pageIcon,
  headerExtras,
}: PageHeaderState & { children: ReactNode }) {
  const setHeader = useContext(PageHeaderSetterContext);

  useLayoutEffect(() => {
    if (!setHeader) return;

    const next = { pageTitle, pageSubtitle, pageIcon, headerExtras };
    setHeader((current) => (sameHeader(current, next) ? current : next));
  }, [headerExtras, pageIcon, pageSubtitle, pageTitle, setHeader]);

  return <>{children}</>;
}
