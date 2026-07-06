import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const IMPERSONATE_COOKIE = "impersonate_org_id";

export interface RenderOrgInfo {
  orgId: string;
  orgName: string;
  isImpersonating: boolean;
}

// getCurrentRenderOrgInfo — Server-side helper: đọc "org đang render" cho
// layout dashboard nhúng data-render-org-id + banner đọc org name.
//
// Nguồn org-id:
//   1. Có cookie impersonate → org từ cookie (platform admin impersonating).
//   2. Không cookie → org từ JWT (tenant thường).
//
// Trả null nếu không auth (login page) hoặc user chưa gán org.
//
// Chú ý: KHÔNG dùng làm nguồn ghi. Vế 4 so vs ctx.organizationId (guard đọc
// TOKEN, không cookie). Helper này chỉ để render UI + nhúng data-attribute.
export async function getCurrentRenderOrgInfo(): Promise<RenderOrgInfo | null> {
  const cookieStore = await cookies();
  const impersonateOrgId = cookieStore.get(IMPERSONATE_COOKIE)?.value;

  const admin = createAdminClient();

  if (impersonateOrgId) {
    const { data: org } = await admin
      .from("organizations")
      .select("id, name")
      .eq("id", impersonateOrgId)
      .maybeSingle();
    if (!org) return null;
    return { orgId: org.id, orgName: org.name, isImpersonating: true };
  }

  // Không impersonate: đọc org từ JWT user
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub as string | undefined;
  const jwtOrgId = claimsData?.claims?.organization_id as string | undefined;

  if (!userId) return null;

  // Ưu tiên orgId từ JWT nếu có; nếu không (edge case) query user_profiles
  let orgId = jwtOrgId;
  if (!orgId) {
    const { data: profile } = await admin
      .from("user_profiles")
      .select("organization_id")
      .eq("id", userId)
      .maybeSingle();
    orgId = profile?.organization_id ?? undefined;
  }
  if (!orgId) return null;

  const { data: org } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return null;

  return { orgId: org.id, orgName: org.name, isImpersonating: false };
}
