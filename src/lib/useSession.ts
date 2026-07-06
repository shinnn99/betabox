"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "./supabase/client";
import { ROLE_LABEL, type Role, type Session } from "./auth";
import { apiFetch, useImpersonatingOrgId } from "./api-fetch";

export function useSession(redirectIfNone = false) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();
  const impersonatingOrgId = useImpersonatingOrgId();

  const load = useCallback(async () => {
    const { data: claimsData } = await supabase.auth.getClaims();
    const claims = claimsData?.claims;

    if (!claims) {
      setSession(null);
      setLoading(false);
      if (redirectIfNone) router.replace("/login");
      return;
    }

    const userId = claims.sub as string;
    const email = (claims.email as string) ?? "";
    const role = (claims.user_role as Role) ?? "viewer";
    const organizationId = (claims.organization_id as string) ?? "";

    // Nếu JWT không có organization_id → có thể là platform admin impersonating.
    // Gọi /api/session-context để lấy effective ctx từ guard 3 lớp (org từ
    // token impersonate). Fallback cho tenant thường vẫn dùng đường JWT + query
    // user_profiles như cũ (nhanh hơn, không thêm round-trip).
    if (!organizationId) {
      try {
        const res = await apiFetch(
          "/api/session-context",
          { cache: "no-store" },
          impersonatingOrgId
        );
        if (res.ok) {
          const ctx = await res.json();
          setSession({
            userId: ctx.userId,
            email: ctx.email,
            fullName: ctx.fullName,
            role: ctx.role as Role,
            roleLabel: ROLE_LABEL[ctx.role as Role] ?? ctx.role,
            organizationId: ctx.organizationId,
            organizationName: ctx.organizationName,
            phone: ctx.phone,
          });
          setLoading(false);
          return;
        }
      } catch {
        // Fallback đường JWT bên dưới
      }
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("full_name, phone, organization_id, organizations(name)")
      .eq("id", userId)
      .single();

    type ProfileRow = {
      full_name: string | null;
      phone: string | null;
      organization_id: string;
      organizations: { name: string } | { name: string }[] | null;
    };

    const row = profile as ProfileRow | null;
    const orgs = row?.organizations;
    const organizationName = Array.isArray(orgs)
      ? orgs[0]?.name ?? ""
      : orgs?.name ?? "";

    setSession({
      userId,
      email,
      fullName: row?.full_name ?? email,
      role,
      roleLabel: ROLE_LABEL[role] ?? role,
      organizationId: row?.organization_id ?? organizationId,
      organizationName,
      phone: row?.phone ?? null,
    });
    setLoading(false);
  }, [redirectIfNone, router, supabase, impersonatingOrgId]);

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
