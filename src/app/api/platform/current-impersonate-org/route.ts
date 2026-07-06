import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const IMPERSONATE_COOKIE = "impersonate_org_id";

// GET /api/platform/current-impersonate-org
// Đường 3 (UX làm mới tab): client watcher fetch endpoint này khi visibilitychange
// / focus / interval 3s → so với org-render nhúng server-side → lệch → reload.
//
// Không cần auth: chỉ trả cookie hiện tại (JS không đọc HttpOnly cookie được →
// client cần endpoint này để biết cookie đổi hay chưa). Kể cả tenant thường
// cũng gọi (trả null nếu không có cookie) — không nguy vì chỉ nội dung cookie.
export async function GET() {
  const cookieStore = await cookies();
  const orgId = cookieStore.get(IMPERSONATE_COOKIE)?.value ?? null;
  return NextResponse.json({ orgId });
}
