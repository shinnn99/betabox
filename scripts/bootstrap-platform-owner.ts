// Bootstrap first platform owner — chạy MỘT LẦN tạo tài khoản vạn năng.
//
// Thứ tự cứng (Hạnh chốt): nâng-platform là bước CUỐI, sau 2FA verified.
// Cửa sổ owner-chưa-2FA = 0.
//
// Chạy: node --experimental-strip-types --env-file=.env.local scripts/bootstrap-platform-owner.ts
//
// Prompt inline: email + password (KHÔNG env — tránh shell history).
// Script không ghi secret TOTP ra file — console một lần, Hạnh tự cất giấy.
//
// Bỏ cuộc (OTP sai 3 lần / Ctrl-C) → cleanup: unenroll factor + xóa user.

import { createClient } from "@supabase/supabase-js";
import passwordPrompt from "@inquirer/password";
import inputPrompt from "@inquirer/input";
import confirmPrompt from "@inquirer/confirm";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE env vars");
  process.exit(1);
}

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Prompt qua @inquirer/prompts — chạy chắc Windows PowerShell, Unix, CMD.
// Node readline/promises + Windows PS có bug (không đợi input, exit ngay
// sau @inquirer), verified bằng test-mask.ts. Dùng thống nhất @inquirer
// cho mọi prompt (input, password, confirm) — nhất quán, không xung đột.

async function ask(q: string): Promise<string> {
  const result = await inputPrompt({ message: q });
  return result.trim();
}

async function askPassword(q: string): Promise<string> {
  const result = await passwordPrompt({ message: q, mask: "*" });
  return result.trim();
}

async function askConfirm(q: string, defaultYes: boolean = true): Promise<boolean> {
  return await confirmPrompt({ message: q, default: defaultYes });
}

async function cleanup(userId: string | null, reason: string): Promise<void> {
  console.log(`\n[cleanup] ${reason}`);
  if (!userId) {
    console.log("[cleanup] không có user_id để dọn.");
    return;
  }
  try {
    // Xóa factor MFA (nếu đã enroll)
    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
    for (const f of factors?.factors ?? []) {
      await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
      console.log(`[cleanup] xóa factor ${f.id}`);
    }
  } catch (e) {
    console.error(`[cleanup] listFactors/deleteFactor error:`, e);
  }
  try {
    await admin.auth.admin.deleteUser(userId);
    console.log(`[cleanup] xóa auth.users ${userId}`);
  } catch (e) {
    console.error(`[cleanup] deleteUser error:`, e);
  }
  // Verify cleanup
  const { data: check } = await admin.auth.admin.getUserById(userId);
  if (check?.user) {
    console.error(`[cleanup] ✗ user vẫn tồn tại: ${userId}`);
  } else {
    console.log(`[cleanup] ✓ verified user đã xóa`);
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BOOTSTRAP FIRST PLATFORM OWNER (V5)");
  console.log("  Tạo tài khoản vạn năng — chạy MỘT LẦN, không revert được dễ.");
  console.log(`  Project: ${SUPA_URL}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const confirm = await askConfirm("Xác nhận chạy trên project TRÊN?", false);
  if (!confirm) {
    console.log("Aborted.");
    process.exit(0);
  }

  // BƯỚC 0: Prompt inline email + password
  const email = await ask("\nEmail platform owner (ví dụ betabox@betacom.vn): ");
  if (!email.includes("@")) {
    console.error("Email invalid.");
    process.exit(1);
  }

  const password = await askPassword("Password (≥12 ký tự, khuyến nghị ≥16 random): ");
  if (password.length < 12) {
    console.error(`✗ Password quá ngắn (${password.length} < 12). Aborted.`);
    process.exit(1);
  }

  const passwordConfirm = await askPassword("Nhập lại password xác nhận: ");
  if (password !== passwordConfirm) {
    console.error("✗ Password không khớp. Aborted.");
    process.exit(1);
  }

  let userId: string | null = null;

  try {
    // BƯỚC 1: createUser (không org, không profile)
    console.log("\n[1/8] Tạo auth.users...");
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) {
      throw new Error(`createUser: ${createErr?.message}`);
    }
    userId = created.user.id;
    console.log(`  ✓ auth.users id=${userId}`);

    // Verify ngay: không lai tenant
    const { count: profileCount } = await admin
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", userId);
    if ((profileCount ?? 0) > 0) {
      throw new Error(
        `Betabox có user_profiles (${profileCount}) — lai tenant! Phải điều tra trigger auto-create.`
      );
    }
    console.log(`  ✓ verify user_profiles=0 (không lai tenant)`);

    // BƯỚC 2: signInWithPassword để có session cho enroll MFA
    console.log("\n[2/8] Sign-in để có session...");
    const userClient = createClient(SUPA_URL, ANON);
    const { data: signIn, error: signInErr } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !signIn.session) {
      throw new Error(`signIn: ${signInErr?.message}`);
    }
    console.log(`  ✓ session access_token length=${signIn.session.access_token.length}`);

    // BƯỚC 3: Cảnh báo TRƯỚC enroll
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  [3/8] SẮP HIỆN QR + SECRET TOTP TRÊN CONSOLE");
    console.log("  ");
    console.log("  Chuẩn bị TRƯỚC khi nhấn Enter:");
    console.log("  - Authenticator app mở sẵn (Authy/1Password/Bitwarden — B1)");
    console.log("  - Giấy + bút để ghi TOTP secret cất két (B2)");
    console.log("  ");
    console.log("  QR + secret CHỈ hiện MỘT LẦN — không lưu file.");
    console.log("═══════════════════════════════════════════════════════════════");
    await askConfirm("Đã chuẩn bị authenticator + giấy?", true);

    // Enroll TOTP factor
    console.log("\n[3/8] Enroll TOTP factor...");
    const { data: enroll, error: enrollErr } = await userClient.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `platform_owner_${email}`,
    });
    if (enrollErr || !enroll) {
      throw new Error(`enroll: ${enrollErr?.message}`);
    }

    console.log("\n───────────────── TOTP ENROLLMENT ─────────────────");
    console.log(`  Factor ID:   ${enroll.id}`);
    console.log(`  QR (URI):    ${enroll.totp.uri}`);
    console.log(`  Secret:      ${enroll.totp.secret}`);
    console.log(`  QR (SVG):    <bỏ qua console — dùng URI ở trên>`);
    console.log("───────────────────────────────────────────────────");
    console.log("\n  → Scan QR bằng authenticator app (B1)");
    console.log("  → Ghi Secret ra giấy cất két (B2 — nhạy ngang password)");
    console.log("");

    // BƯỚC 4-5: Prompt OTP với retry
    let verified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const code = await ask(`[4/8] Nhập OTP 6-digit từ authenticator (thử ${attempt}/3): `);
      if (!/^\d{6}$/.test(code)) {
        console.log(`  ✗ Không phải 6-digit. Thử lại.`);
        continue;
      }

      const { data: challenge, error: chErr } = await userClient.auth.mfa.challenge({
        factorId: enroll.id,
      });
      if (chErr || !challenge) {
        console.log(`  ✗ challenge fail: ${chErr?.message}`);
        continue;
      }

      const { data: verify, error: vErr } = await userClient.auth.mfa.verify({
        factorId: enroll.id,
        challengeId: challenge.id,
        code,
      });
      if (vErr || !verify) {
        console.log(`  ✗ verify fail: ${vErr?.message}`);
        continue;
      }

      verified = true;
      console.log(`  ✓ TOTP verified!`);
      break;
    }

    if (!verified) {
      await cleanup(userId, "OTP sai 3 lần — cleanup và chạy lại");
      process.exit(1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TỪ ĐÂY TRỞ ĐI: 2FA ĐÃ VERIFIED. User + 2FA là công-người (Hạnh scan
    // QR, nhập OTP). INSERT là công-máy (một câu SQL). Nếu INSERT fail,
    // KHÔNG xóa user — retry INSERT. Đừng vứt công-người vì lỗi việc-máy.
    // Xử fail INSERT ở đây RIÊNG (không throw ra catch chung — catch chung
    // sẽ hỏi xóa user, sai với ca sau-2FA).
    // ═══════════════════════════════════════════════════════════════════════

    // BƯỚC 6: SAU verified → INSERT platform_admins (bước CUỐI, cửa sổ = 0)
    let inserted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n[5/8] INSERT platform_admins (thử ${attempt}/3)...`);
      const { error: insertErr } = await admin.from("platform_admins").insert({
        id: userId,
        role: "platform_owner",
        status: "active",
        created_by: null, // owner đầu, không có ai tạo
        notes: `First platform owner bootstrapped ${new Date().toISOString()} — email: ${email}`,
      });
      if (!insertErr) {
        inserted = true;
        console.log(`  ✓ ${email} giờ là platform_owner`);
        break;
      }
      console.log(`  ✗ INSERT fail: ${insertErr.message}`);
      if (attempt < 3) {
        await askConfirm(
          `Retry INSERT? (2FA đã verified, KHÔNG xóa user)`,
          true
        );
      }
    }

    if (!inserted) {
      // Fail hết retry. GIỮ user + 2FA (công-người đã xong), báo Hạnh SQL tay.
      console.log("\n═══════════════════════════════════════════════════════════════");
      console.log("  ⚠ INSERT platform_admins FAIL sau 3 lần retry");
      console.log("  ");
      console.log(`  User ${email} (id=${userId}) đã có 2FA verified.`);
      console.log("  GIỮ user (không xóa) — 2FA scan/OTP là công tay Hạnh, không vứt.");
      console.log("  ");
      console.log("  Xử tay: chạy SQL trong Supabase Studio SQL Editor:");
      console.log("  ");
      console.log(`    INSERT INTO public.platform_admins (id, role, status, created_by, notes)`);
      console.log(`    VALUES (`);
      console.log(`      '${userId}',`);
      console.log(`      'platform_owner',`);
      console.log(`      'active',`);
      console.log(`      NULL,`);
      console.log(`      'First platform owner (bootstrap retry-fail, manual INSERT)'`);
      console.log(`    );`);
      console.log("═══════════════════════════════════════════════════════════════\n");
      process.exit(1);
    }

    // BƯỚC 7: 5 query verify
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  [6/8] VERIFY BẰNG 5 QUERY (bằng chứng đo được, không báo cáo)");
    console.log("═══════════════════════════════════════════════════════════════");

    // Q1: auth.users
    const { data: authCheck } = await admin.auth.admin.getUserById(userId);
    console.log(`  Q1 auth.users id=${userId}: ${authCheck?.user ? "✓ tồn tại" : "✗ KHÔNG"}`);

    // Q2: mfa_factors totp verified — dùng REST admin API (schema auth,
    // không public.mfa_factors nên không query trực tiếp qua admin.from)
    const { data: factorList } = await admin.auth.admin.mfa.listFactors({ userId });
    const verifiedTotp = factorList?.factors?.find(
      (f) => f.factor_type === "totp" && f.status === "verified"
    );
    console.log(
      `  Q2 mfa_factors totp verified: ${verifiedTotp ? "✓ 1 row" : "✗ KHÔNG"}`
    );

    // Q3: platform_admins
    const { data: platformCheck } = await admin
      .from("platform_admins")
      .select("id, role, status")
      .eq("id", userId)
      .maybeSingle();
    console.log(
      `  Q3 platform_admins: ${
        platformCheck?.role === "platform_owner" && platformCheck.status === "active"
          ? "✓ platform_owner active"
          : "✗ KHÔNG"
      }`
    );

    // Q4: user_profiles = 0 (không lai)
    const { count: profileFinal } = await admin
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", userId);
    console.log(
      `  Q4 user_profiles=${profileFinal ?? 0}: ${
        (profileFinal ?? 0) === 0 ? "✓ không lai tenant" : "✗ LAI tenant"
      }`
    );

    // Q5: user_profiles check LẠI (đã log ở bước 1 rồi)
    console.log(`  Q5 user_profiles check sau bước 1 đã log '✓ verify user_profiles=0'`);

    const allOk =
      authCheck?.user &&
      verifiedTotp &&
      platformCheck?.role === "platform_owner" &&
      (profileFinal ?? 0) === 0;

    console.log("\n═══════════════════════════════════════════════════════════════");
    if (allOk) {
      console.log("  ✓ V5 BOOTSTRAP XONG");
      console.log(`  Email: ${email}`);
      console.log(`  User ID: ${userId}`);
      console.log("  Recovery: (a) authenticator sync + (b) secret giấy cất két");
      console.log("═══════════════════════════════════════════════════════════════\n");
    } else {
      console.log("  ✗ VERIFY FAIL — có bước không đúng, review log");
      console.log("═══════════════════════════════════════════════════════════════\n");
      process.exit(1);
    }
  } catch (err) {
    // Catch chung chỉ chạy cho fail-TRƯỚC-2FA-verified (createUser fail,
    // signIn fail, enroll fail, exception giữa chừng). Fail-INSERT-sau-2FA
    // đã xử riêng ở khối INSERT retry — không throw ra catch này.
    console.error("\n✗ Fatal (trước 2FA verified):", err);
    if (userId) {
      const wipe = await askConfirm(
        "User tạo dở (2FA CHƯA xong) — xóa user?",
        true
      );
      if (wipe) {
        await cleanup(userId, "user chọn xóa (fail trước 2FA)");
      } else {
        console.log(`⚠ User ${userId} giữ nguyên trạng thái LỬNG. Xử tay.`);
      }
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
