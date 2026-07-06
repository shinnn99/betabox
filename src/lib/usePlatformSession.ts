"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "./supabase/client";

export interface PlatformSession {
  userId: string;
  email: string;
  platformRole: "platform_owner" | "platform_support";
}

/**
 * Hook cho trang /platform/* — tương đương useSession cho tenant nhưng dành
 * cho platform admin (không có organization). Fetch qua /api/platform/context
 * (route gate bằng requirePlatformRole).
 *
 * redirectIfNone: true → redirect /login nếu không phải platform admin.
 */
export function usePlatformSession(redirectIfNone = false) {
  const router = useRouter();
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform/context", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setSession(null);
        setLoading(false);
        if (redirectIfNone) {
          router.replace("/login");
        }
        return;
      }
      const data = await res.json();
      setSession({
        userId: data.userId,
        email: data.email,
        platformRole: data.platformRole,
      });
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [redirectIfNone, router]);

  useEffect(() => {
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setSession(null);
        if (redirectIfNone) router.replace("/login");
      } else {
        load();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [load, redirectIfNone, router, supabase]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    router.replace("/login");
  }, [router, supabase]);

  return { session, loading, signOut };
}
