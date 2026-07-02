import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth"];

// API endpoints that authenticate themselves (HMAC, signed webhooks, etc.)
// and must not be intercepted by the session-based auth proxy.
const PUBLIC_API_PREFIXES = [
  "/api/warehouse/scans",
  "/api/warehouse/heartbeat",
  "/api/warehouse/discovery",
  "/api/warehouse/maintenance/close-stale-sessions",
  // Cloud → Agent command channel: HMAC-authenticated, không có
  // session cookie. Phải bypass proxy nếu không sẽ bị redirect
  // 307 /login và agent không đến được route.
  "/api/agent/poll-commands",
  "/api/agent/command-result",
  "/api/agent/recording-credentials",
  "/api/agent/recording-status",
  "/api/agent/recording-files",
  "/api/agent/clip-cut-result",
  "/api/agent/clip-upload-url",
  "/api/agent/clip-upload-complete",
  "/api/agent/camera-probe",
  // 1.1: Vercel Cron endpoint — tự check Authorization: Bearer $CRON_SECRET
  // trong route. Không có session cookie, phải bypass proxy nếu không sẽ
  // bị 401 trước khi route được gọi.
  "/api/cron",
];

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Skip session refresh entirely for HMAC-authenticated APIs.
  if (PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
          if (headers) {
            Object.entries(headers).forEach(([key, value]) =>
              supabaseResponse.headers.set(key, value)
            );
          }
        },
      },
    }
  );

  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));

  if (!user && !isPublic) {
    // API vs page: API trả 401 JSON (client fetch parse được, phân biệt
    // rõ "session hết hạn" khỏi "network error"); page redirect /login
    // (user experience). Grep dương 2026-07-02 xác nhận không route nào
    // dựa 307-redirect-tới-login để đá client, nên đổi 401 an toàn +
    // sửa silent-broken cũ (client fetch API → 307 → follow → /login
    // HTML → .json() fail catch nuốt).
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "unauthenticated" },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
