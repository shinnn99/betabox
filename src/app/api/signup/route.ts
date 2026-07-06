import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ============================================================================
// POST /api/signup — Cửa CÔNG KHAI vào SaaS. Bề mặt tấn công lớn nhất.
//
// Hai mắt xích nhạy (Hạnh cứng):
//   1. Transaction tạo user+org+profile — fail giữa chừng phải cleanup auth
//      để không có user mồ côi (leak-lặng).
//   2. Rate-limit (chống một-nguồn) + Turnstile (chống bot đa-IP) — không skip.
//
// Turnstile env-gated:
//   - Dev không set TURNSTILE_SECRET_KEY → skip verify + log warn.
//   - Prod thiếu key → refuse signup 500 (không lặng bypass).
// ============================================================================

const RATE_LIMIT_IP_PER_HOUR = 5;
const RATE_LIMIT_EMAIL_PER_DAY = 3;
const PASSWORD_MIN_LENGTH = 8;
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SignupBody {
  email?: string;
  password?: string;
  full_name?: string;
  organization_name?: string;
  phone?: string;
  turnstile_token?: string;
}

// ── Slug generator: normalize + collision retry với hậu tố -2, -3, ...
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip Vietnamese diacritics
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60); // tránh slug quá dài
}

function getClientIp(req: Request): string {
  // Vercel + Cloudflare hay set x-forwarded-for hoặc cf-connecting-ip
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "127.0.0.1"; // fallback dev local
}

// ── Turnstile verify (env-gated: dev skip có log, prod bắt buộc)
async function verifyTurnstile(token: string | undefined, ip: string): Promise<
  { ok: true } | { ok: false; error: string; status: number }
> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      // Prod thiếu key → refuse (không lặng bypass)
      console.error(
        "[signup] PROD missing TURNSTILE_SECRET_KEY — refuse signup"
      );
      return {
        ok: false,
        error: "captcha_not_configured",
        status: 500,
      };
    }
    console.warn(
      "[signup] dev bypass Turnstile (TURNSTILE_SECRET_KEY not set)"
    );
    return { ok: true };
  }

  if (!token) {
    return { ok: false, error: "captcha_missing", status: 400 };
  }

  // Verify với Cloudflare
  const formData = new URLSearchParams({
    secret,
    response: token,
    remoteip: ip,
  });

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: formData,
    });
    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    if (!data.success) {
      console.warn("[signup] Turnstile verify fail", {
        errors: data["error-codes"],
        ip,
      });
      return { ok: false, error: "captcha_failed", status: 400 };
    }
    return { ok: true };
  } catch (err) {
    console.error("[signup] Turnstile fetch error:", err);
    return { ok: false, error: "captcha_verify_error", status: 502 };
  }
}

// ── Rate-limit: 5/IP/giờ + 3/email/ngày
async function checkRateLimit(
  ip: string,
  email: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const nowMs = Date.now();
  const hourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const { count: ipCount } = await admin
    .from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", hourAgo);

  if ((ipCount ?? 0) >= RATE_LIMIT_IP_PER_HOUR) {
    return { ok: false, error: "rate_limit_ip" };
  }

  const { count: emailCount } = await admin
    .from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .gte("created_at", dayAgo);

  if ((emailCount ?? 0) >= RATE_LIMIT_EMAIL_PER_DAY) {
    return { ok: false, error: "rate_limit_email" };
  }

  return { ok: true };
}

// ── Slug collision retry: nếu slug base trùng → thêm -2, -3, ..., tối đa 20 lần
async function findAvailableSlug(baseSlug: string): Promise<string | null> {
  const admin = createAdminClient();
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return null; // hết retry
}

export async function POST(req: Request) {
  // Phanh khẩn Mốc 2: khi Betacom chưa muốn mở signup public dù đã deploy prod
  // (VD checklist Mốc 2 chưa đóng hết: chưa rotate secret, chưa verify Ca 5
  // platform-token nửa-âm, chưa Turnstile prod key). Set env
  // `SIGNUP_ENABLED=false` (hoặc bỏ trắng cho về mặc định false) → route trả
  // 503. Set `SIGNUP_ENABLED=true` khi checklist đóng đủ.
  //
  // Default false = "phanh khi không rõ" — an toàn hơn "mở khi không rõ".
  // Xem cọc project_moc2_checklist_mo_khach:64-66.
  if (process.env.SIGNUP_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "signup_disabled",
        message:
          "Đăng ký khách mới tạm chưa mở. Vui lòng liên hệ Betacom để được cấp tài khoản.",
      },
      { status: 503 },
    );
  }

  const ip = getClientIp(req);

  const body: SignupBody = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const orgName = String(body.organization_name ?? "").trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const turnstileToken = body.turnstile_token;

  // Log attempt SỚM (dù có fail sau, vẫn count vào rate-limit — chống bypass
  // rate-limit bằng cách gửi body invalid liên tục).
  //
  // Capture id để update succeeded=true chính xác row này sau. Update bằng
  // (ip, email, order, limit) như trước không được PostgREST đảm bảo bounded
  // — có thể update sai row hoặc 0 row silent (bug agent 1 phát hiện 2026-07-06).
  const admin = createAdminClient();
  const { data: attempt, error: attemptErr } = await admin
    .from("signup_attempts")
    .insert({
      ip,
      email: email || "<empty>",
      succeeded: false,
    })
    .select("id")
    .single();
  if (attemptErr) {
    // Audit-critical: signup_attempts là bằng chứng rate-limit + audit trail.
    // Fail = mất trace. Log để ops thấy — KHÔNG fail-close signup nghiệp vụ
    // (không muốn ai đó DoS rate-limit table làm hỏng đăng ký hoàn toàn).
    console.error(
      `[signup] attempt insert failed ip=${ip} email_hash=${(email || "<empty>").slice(0, 3)}*** code=${attemptErr.code ?? "?"} message=${attemptErr.message}`,
    );
  }
  const attemptId = attempt?.id as string | undefined;

  // ── Validate input
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { error: "validation", message: "Email không hợp lệ." },
      { status: 400 }
    );
  }
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return NextResponse.json(
      {
        error: "validation",
        message: `Mật khẩu tối thiểu ${PASSWORD_MIN_LENGTH} ký tự.`,
      },
      { status: 400 }
    );
  }
  if (!fullName) {
    return NextResponse.json(
      { error: "validation", message: "Họ tên bắt buộc." },
      { status: 400 }
    );
  }
  if (!orgName) {
    return NextResponse.json(
      { error: "validation", message: "Tên tổ chức bắt buộc." },
      { status: 400 }
    );
  }

  // ── Turnstile verify (env-gated)
  const captcha = await verifyTurnstile(turnstileToken, ip);
  if (!captcha.ok) {
    return NextResponse.json(
      { error: captcha.error },
      { status: captcha.status }
    );
  }

  // ── Rate-limit
  const rl = await checkRateLimit(ip, email);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: rl.error,
        message:
          rl.error === "rate_limit_ip"
            ? `Đã đăng ký quá ${RATE_LIMIT_IP_PER_HOUR} lần trong 1 giờ từ IP này.`
            : `Đã đăng ký quá ${RATE_LIMIT_EMAIL_PER_DAY} lần trong 1 ngày với email này.`,
      },
      { status: 429 }
    );
  }

  // ── Slug: generate + collision retry
  const baseSlug = slugify(orgName);
  if (!baseSlug) {
    return NextResponse.json(
      { error: "validation", message: "Tên tổ chức không tạo được slug hợp lệ." },
      { status: 400 }
    );
  }
  const slug = await findAvailableSlug(baseSlug);
  if (!slug) {
    return NextResponse.json(
      { error: "slug_exhausted", message: "Không thể tạo slug (quá nhiều trùng)." },
      { status: 500 }
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // TRANSACTION: tạo auth.users → org → user_profiles.
  // auth.users tạo TRƯỚC qua Auth API (không trong SQL transaction).
  // Nếu SQL insert org/profile fail → PHẢI xóa auth.users để không có
  // user mồ côi (leak-lặng, tích dần khó phát hiện).
  // ══════════════════════════════════════════════════════════════════════
  let createdUserId: string | null = null;

  try {
    // Bước 1: tạo auth.users
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // signup tự động confirm — không đòi verify email lượt đầu
      });

    if (createErr || !created?.user) {
      // Email đã dùng → 409 conflict
      if (createErr?.message?.toLowerCase().includes("already")) {
        return NextResponse.json(
          {
            error: "email_taken",
            message: "Email này đã đăng ký.",
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "auth_create_failed", message: createErr?.message ?? "" },
        { status: 400 }
      );
    }
    createdUserId = created.user.id;

    // Bước 2: tạo organization
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .insert({ name: orgName, slug })
      .select("id")
      .single();

    if (orgErr || !org) {
      throw new Error(`org_insert: ${orgErr?.message}`);
    }

    // Bước 3: tạo user_profiles (role=owner)
    const { error: profileErr } = await admin.from("user_profiles").insert({
      id: createdUserId,
      organization_id: org.id,
      role: "owner",
      full_name: fullName,
      phone,
      status: "active",
    });

    if (profileErr) {
      // Rollback org đã tạo (user cleanup ở catch)
      await admin.from("organizations").delete().eq("id", org.id);
      throw new Error(`profile_insert: ${profileErr.message}`);
    }

    // Success → mark signup_attempts succeeded, target đúng id đã capture
    // ở đầu route (không dùng ip+email+order+limit — PostgREST không đảm bảo
    // bounded update, có thể update sai row hoặc 0 row silent).
    if (attemptId) {
      const { error: succErr } = await admin
        .from("signup_attempts")
        .update({ succeeded: true })
        .eq("id", attemptId);
      if (succErr) {
        // Signup thành công nhưng flag succeeded chưa flip → rate-limit
        // count vẫn tăng. Log để ops audit; không rollback nghiệp vụ.
        console.error(
          `[signup] attempt succeeded flag update failed attempt=${attemptId} code=${succErr.code ?? "?"} message=${succErr.message}`,
        );
      }
    }

    return NextResponse.json(
      {
        ok: true,
        user_id: createdUserId,
        organization_id: org.id,
        slug,
      },
      { status: 201 }
    );
  } catch (err) {
    // CLEANUP MỒ CÔI: xóa auth.users đã tạo (nếu có)
    if (createdUserId) {
      try {
        await admin.auth.admin.deleteUser(createdUserId);
        console.error(
          `[signup] rollback auth.users ${createdUserId} due to:`,
          err
        );
      } catch (delErr) {
        console.error(
          `[signup] CRITICAL: failed cleanup auth.users ${createdUserId}:`,
          delErr
        );
      }
    }
    return NextResponse.json(
      {
        error: "signup_failed",
        message: (err as Error).message,
      },
      { status: 500 }
    );
  }
}
