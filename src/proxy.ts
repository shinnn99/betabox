import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { updateSession } from "@/lib/supabase/proxy";
import {
  stripInternalHeadersInPlace,
  signOrgContext,
} from "@/lib/platform/internal-headers";
import { checkPlatformAdmin } from "@/lib/platform/admin-check";

const INTERNAL_ORG_CTX_HEADER = "x-internal-org-ctx";
const IMPERSONATE_COOKIE = "impersonate_org_id";

export async function proxy(request: NextRequest) {
  // ==========================================================================
  // KHỐI 1: STRIP TUYỆT ĐỐI ĐẦU TIÊN
  // Xóa mọi header x-internal-* từ client TRƯỚC bất kỳ logic nào.
  // ==========================================================================
  stripInternalHeadersInPlace(request);

  // ==========================================================================
  // KHỐI 2: IMPERSONATE COOKIE-CARRIER
  //
  // Cookie `impersonate_org_id` HttpOnly (JS không đọc/sửa) — carrier org-id
  // tới proxy. Proxy VẪN gate platform-admin + VẪN ký x-internal-org-ctx
  // token; guard VẪN verify token. Cookie chỉ chở-tới-proxy, KHÔNG phải
  // nguồn-org-id-ở-guard (guard đọc token, không cookie).
  //
  // Không rewrite URL: URL browser giữ /dashboard/* như tenant thường
  // → Next 16 client router hoạt động bình thường (không navigation-abort).
  //
  // Trade-off (Hạnh chốt):
  // - Một-org-một-lúc (cookie global, không hai-tab-hai-org song song).
  // - Banner đỏ đọc cookie server-side mỗi request (không state cache).
  // - Tab-tự-reload đường 3 (endpoint check + poll khi visible).
  // - Chặn ghi vế 4 khi x-render-org-id ≠ ctx.organizationId (guard 409).
  //
  // Ba nhánh cookie:
  //   1. Không cookie → non-impersonate flow bình thường (guard đọc org user).
  //   2. Có cookie + user platform-admin → ký token forward vào request.
  //   3. Có cookie + user KHÔNG platform-admin → xóa cookie + 403.
  //      (Không ký token → guard rơi non-token → tenant về org mình. Token
  //      gate chặn, không cookie chặn — dù cookie inject được cũng vô hại
  //      vì gate platform-admin trước ký.)
  // ==========================================================================
  const impersonateOrgId = request.cookies.get(IMPERSONATE_COOKIE)?.value;
  const pathname = request.nextUrl.pathname;

  // Cookie impersonate có thể sống lâu hơn session (user logout, cookie chưa
  // xóa). Skip khối 2 cho public paths (/login, /auth, /signup) để login
  // hoạt động; skip cho static /_next/*.
  const isPublicPath =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/_next/");

  if (impersonateOrgId && !isPublicPath) {
    // Session refresh — nếu chưa auth, trả redirect/401
    const sessionResponse = await updateSession(request);
    if (
      sessionResponse.status >= 400 ||
      sessionResponse.headers.get("location")
    ) {
      return sessionResponse;
    }

    // Client riêng lấy uid từ session vừa refresh + apply cookie mới nếu
    // getClaims trigger refresh.
    const cookiesToWrite: {
      name: string;
      value: string;
      options?: Record<string, unknown>;
    }[] = [];

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(newCookies) {
            for (const { name, value, options } of newCookies) {
              request.cookies.set(name, value);
              cookiesToWrite.push({ name, value, options });
            }
          },
        },
      }
    );

    const { data: claimsData } = await supabase.auth.getClaims();
    const userId = claimsData?.claims?.sub as string | undefined;
    if (!userId) {
      // Session hết hạn nhưng cookie impersonate còn — dọn cookie stale +
      // trả về nhánh non-impersonate (updateSession sẽ xử: page redirect
      // /login, API trả 401 JSON). Không throw no_user_id — cho updateSession
      // decide đường xử phù hợp path.
      const cleanupRes = await updateSession(request);
      cleanupRes.cookies.set(IMPERSONATE_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: "/",
        maxAge: 0,
      });
      return cleanupRes;
    }

    // Check platform admin — lớp B (một nguồn sự thật, dùng chung với guard)
    const platform = await checkPlatformAdmin(userId);
    if (!platform) {
      // Tenant KHÔNG platform-admin đã có cookie impersonate (giả/stale) →
      // dọn cookie + redirect về chính URL đó (browser gửi request 2 KHÔNG
      // có cookie → khối 3 chạy → tenant bình thường).
      //
      // Cookie inject vô hại vì token gate ở đây: không ký token → data
      // không lộ. KHÔNG trả 403 JSON dừng app — redirect sạch UX tốt hơn.
      //
      // Redirect (thay dọn-cookie-inline) tránh quirk request-1-đang-xử-lý
      // vẫn thấy cookie: request.cookies (server-side) còn cookie khi
      // downstream render → layout đọc cookie sai → banner sai org. Redirect
      // → browser gửi request 2 với cookie đã xóa → mọi thứ sạch.
      const redirectUrl = request.nextUrl.clone();
      const redirect = NextResponse.redirect(redirectUrl);
      redirect.cookies.set(IMPERSONATE_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: "/",
        maxAge: 0,
      });
      console.warn("[proxy] non-platform user has impersonate cookie", {
        userId,
        cookieOrgId: impersonateOrgId,
      });
      return redirect;
    }

    // Sign org-context token (HMAC-SHA256, TTL 5 phút)
    const signedToken = await signOrgContext({
      orgId: impersonateOrgId,
      timestamp: Date.now(),
      nonce: crypto.randomUUID(),
    });

    // Forward headers: cookie + signed token (allowlist, không copy-all leak)
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.set(INTERNAL_ORG_CTX_HEADER, signedToken);

    // KHÔNG rewrite URL — dùng NextResponse.next() giữ URL browser nguyên,
    // Next 16 client router hoạt động bình thường.
    const response = NextResponse.next({
      request: { headers: forwardHeaders },
    });

    // Apply cookies từ getClaims refresh (nếu có)
    for (const { name, value, options } of cookiesToWrite) {
      response.cookies.set(name, value, options);
    }

    return response;
  }

  // ==========================================================================
  // KHỐI 3: NON-IMPERSONATE — session refresh như cũ
  // ==========================================================================
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
