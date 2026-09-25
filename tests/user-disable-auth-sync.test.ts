import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Khoá tài khoản phải chạm TẦNG XÁC THỰC, không chỉ cột `user_profiles.status`.
 *
 * Sự cố 2026-09-25: `nguyenhagiang@betacom.vn` hiện "disabled" trên giao diện
 * nhưng vẫn đăng nhập được. Đo trên database thật: status='disabled' mà
 * `auth.users.banned_until IS NULL`, và grep toàn bộ mã nguồn cho thấy KHÔNG
 * chỗ nào từng ghi vào `banned_until`. Supabase Auth không biết cột `status`
 * tồn tại, nên `signInWithPassword` vẫn cấp token như thường.
 *
 * Vì sao nguy: 37 route dùng `requirePermission` (không-strict) đọc vai trò
 * thẳng từ JWT, không hỏi lại DB — người bị khoá vẫn được phục vụ. Chỉ 32
 * route dùng `requirePermissionStrict` mới chặn bằng `account_disabled`.
 */

type UserStatus = "active" | "disabled";

interface AuthCall {
  ban_duration: string;
}

/** Bản sao quyết định trong PATCH /api/users/[id]. */
function planStatusChange(status: UserStatus): {
  auth: AuthCall;
  revokeSessions: boolean;
} {
  return {
    auth: { ban_duration: status === "disabled" ? "876000h" : "none" },
    // Khoá thì phải đá phiên đang mở: GoTrue thu hồi refresh token khi ban,
    // nhưng access token đã phát vẫn sống tới hết hạn (mặc định 1 giờ).
    revokeSessions: status === "disabled",
  };
}

test("khoá: phải ban ở tầng auth, không chỉ đổi cột status", () => {
  const plan = planStatusChange("disabled");
  assert.equal(plan.auth.ban_duration, "876000h");
  assert.notEqual(
    plan.auth.ban_duration,
    "none",
    "quên ban = người bị khoá vẫn đăng nhập được, đúng lỗi 25/09",
  );
});

test("khoá: phải huỷ phiên đang mở, không chờ token hết hạn", () => {
  // Không đá phiên thì cửa sổ hở tới 1 giờ, và trong đó mọi route
  // requirePermission không-strict vẫn phục vụ vì chỉ đọc JWT.
  assert.equal(planStatusChange("disabled").revokeSessions, true);
});

test("mở khoá: gỡ ban, và KHÔNG đá phiên", () => {
  const plan = planStatusChange("active");
  assert.equal(plan.auth.ban_duration, "none");
  // Mở khoá mà vẫn đá phiên là phá ngang người đang làm việc bình thường.
  assert.equal(plan.revokeSessions, false);
});

test("ban_duration đủ dài để coi là khoá vô hạn", () => {
  // 876000h = 100 năm. Số ngắn hơn nghĩa là tài khoản tự mở lại — khoá do
  // người quản trị quyết định thì không được tự hết hạn.
  const hours = Number(planStatusChange("disabled").auth.ban_duration.replace("h", ""));
  assert.ok(hours >= 87_600, `khoá chỉ ${hours} giờ là quá ngắn, sẽ tự mở lại`);
});

/**
 * Chặn giá trị status lạ. Trước đây route nhận thẳng `body.status` bất kỳ
 * chuỗi nào rồi ghi vào DB — gõ nhầm "disable" (thiếu d) là tài khoản không
 * bị khoá mà cũng không ai biết, vì cột chấp nhận tuốt.
 */
const VALID_STATUS: UserStatus[] = ["active", "disabled"];
function isValidStatus(s: string): boolean {
  return (VALID_STATUS as string[]).includes(s);
}

test("chỉ nhận đúng hai trạng thái", () => {
  assert.equal(isValidStatus("active"), true);
  assert.equal(isValidStatus("disabled"), true);
});

test("giá trị lạ bị từ chối, không ghi âm thầm vào DB", () => {
  assert.equal(isValidStatus("disable"), false, "thiếu chữ d — lỗi gõ hay gặp nhất");
  assert.equal(isValidStatus("inactive"), false);
  assert.equal(isValidStatus("banned"), false);
  assert.equal(isValidStatus(""), false);
});
