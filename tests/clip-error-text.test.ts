import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLIP_ERROR_GENERIC,
  clipErrorText,
  clipErrorTextOrNull,
  retryConflictText,
} from "@/lib/order-proof/clip-error-text";
import { STALE_PENDING_ERROR_MESSAGE } from "@/lib/order-proof/stale-pending";

/**
 * Chủ dự án 26/09/2026: "lỗi này trả ra tiếng việt thôi nhé đừng có trả ra
 * hàm báo lỗi" — ảnh danh sách video hiện "Lỗi proof_clip_too_large: 96.6MB v…".
 *
 * Mẫu dưới đây lấy đúng khuôn các chuỗi agent / cloud ghi vào
 * `order_proof_clips.error_message` (kiểm kê 26/09/2026).
 */

const RAW_SAMPLES = [
  "proof_clip_too_large: 96.6MB vượt trần upload 90.0MB (clip 305s, bitrate 2657kbps). Giảm bitrate camera hoặc rút ngắn cửa sổ clip.",
  "clip_expired_retention: video đã quá hạn lưu trữ (giữ 30 ngày)",
  "clip_expired_retention: video đã quá hạn lưu trữ (segment hàng hoàn giữ 7 ngày)",
  "segments_missing_on_disk: CAM01/2026/09/17/CAM01_20260917_101500.mp4, CAM01/2026/09/17/CAM01_20260917_101600.mp4",
  "compose_failed: ffmpeg exited 1: [h264 @ 0x55d] error while decoding MB 12 34",
  "compose_failed: overview has no segments",
  "compose_failed: gate_busy_race",
  "compose_failed: ENOSPC: no space left on device, write",
  "Không tạo được file clip. Chi tiết: [mp4 @ 0x1] Invalid data found | Conversion failed! | exit 1",
  "Không tạo được file clip. ",
  "spawn failed: spawn C:\\BetacomAgent\\ffmpeg.exe ENOENT",
  "cut_clip failed",
  "unsupported_output_codec: hevc",
  "signed_url_fetch_failed: clip_not_pending",
  "signed_url_fetch_failed: fetch failed",
  "read_tmp_failed: ENOENT: no such file or directory, open 'D:\\_clips\\a.b.tmp.mp4'",
  "upload_put_failed[timeout]: timeout after 600000ms attempts=3 elapsed=812345ms",
  "upload_put_failed[http_5xx]: http_503: <html>Service Unavailable</html>",
  "upload_put_failed: socket hang up",
  "notify_complete_failed: bucket_size_mismatch",
  "notify_complete_failed: This operation was aborted",
  "cut_clip payload missing required fields (need clip_id + others)",
  "gate_busy_race",
  "ENOSPC: no space left on device, write",
  "fetch failed",
  "This operation was aborted",
  "cut_failed",
  "regeneration_failed",
  "unknown",
  STALE_PENDING_ERROR_MESSAGE,
  "enqueue_cut_failed: enqueue_clip_generation RPC failed: enqueue_stale_pending_without_active_command: clip_id=3f2c1a9e-1b2c-4d5e-8f90-123456789abc",
  "signed_url_failed: bucket_expired",
  "signed_url_failed: not_ready",
  "simulated_cut_failed",
  "font_missing: C:\\Windows\\Fonts\\arial.ttf",
  "render_mark_failed (after_seg=3, gap=2s): boom",
  "ffmpeg exit 1: Invalid argument",
  "Không có video trong khoảng thời gian đơn hàng (đoạn video trên máy kho đã dọn, hoặc camera chưa ghi hình lúc đó). [reconcile-write-failed]",
  "packing_event_id_invalid",
  "unauthenticated",
  "forbidden",
  "packing_event_not_found",
  "cross_org_access_denied",
  "no_camera_for_event",
  "constructor",
  "",
];

const LEAKS = /[a-z0-9]+_[a-z0-9_]+|\bENO[A-Z]+\b|ffmpeg|\bfetch\b|\bhttp_|\bspawn\b|\[[\w-]+\]|0x[0-9a-f]/i;
const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

test("ảnh chủ dự án: proof_clip_too_large → câu tiếng Việt, số kiểu Việt Nam, việc cần làm", () => {
  assert.equal(
    clipErrorText(RAW_SAMPLES[0]),
    "Video của đơn này quá dung lượng để tải lên (96,6 MB, giới hạn 90,0 MB). Bấm Thử lại để cắt lại — máy kho sẽ ghép và nén lại cho vừa.",
  );
});

test("mọi mẫu lỗi thật ra câu tiếng Việt, không lộ mã, đuôi ffmpeg, lỗi Node", () => {
  for (const raw of RAW_SAMPLES) {
    const out = clipErrorText(raw);
    assert.ok(VIETNAMESE.test(out), `không phải tiếng Việt: ${raw} → ${out}`);
    assert.ok(!LEAKS.test(out), `lộ chuỗi kỹ thuật: ${raw} → ${out}`);
  }
});

test("gọi lại trên câu đã dịch ra đúng câu đó", () => {
  for (const raw of RAW_SAMPLES) {
    const once = clipErrorText(raw);
    assert.equal(clipErrorText(once), once, raw);
  }
});

test("giữ đầu câu danh sách video đang nhận diện: Quá hạn lưu trữ / Không có video", () => {
  assert.equal(
    clipErrorText("clip_expired_retention: video đã quá hạn lưu trữ (giữ 30 ngày)"),
    "Video đã quá hạn lưu trữ (giữ 30 ngày) nên không cắt lại được.",
  );
  assert.equal(
    clipErrorText("clip_expired_retention: video đã quá hạn lưu trữ (segment hàng hoàn giữ 7 ngày)"),
    "Video đã quá hạn lưu trữ (video hàng hoàn giữ 7 ngày) nên không cắt lại được.",
  );
  // Câu route /watch tự ghi — giữ nguyên.
  const expired = "Video đã quá hạn lưu trữ (giữ 35 ngày). Không cắt được clip cho đơn này.";
  assert.equal(clipErrorText(expired), expired);
  const none = "Không có video trong khoảng thời gian đơn hàng (đoạn video trên máy kho đã dọn, hoặc camera chưa ghi hình lúc đó).";
  assert.equal(clipErrorText(none), none);
  // Đuôi kỹ thuật bị bỏ, đầu câu còn nguyên.
  assert.ok(clipErrorText(`${none} [reconcile-write-failed]`).startsWith("Không có video"));
});

test("lỗi cụ thể thắng mã bọc ngoài: ổ đầy, máy kho bận, mất mạng", () => {
  assert.match(clipErrorText("compose_failed: ENOSPC: no space left on device, write"), /Ổ đĩa máy kho đã đầy/);
  assert.match(clipErrorText("gate_busy_race"), /Máy kho đang bận/);
  assert.match(clipErrorText("compose_failed: gate_busy_race"), /Máy kho đang bận/);
  assert.match(clipErrorText("signed_url_fetch_failed: fetch failed"), /mất kết nối mạng/);
  assert.match(clipErrorText("compose_failed: qr has no segments"), /Một góc camera không có video/);
  assert.match(clipErrorText("Không tạo được file clip. Chi tiết: Conversion failed!"), /không tạo được file video/);
  // 413 từ kho lưu trữ là file quá lớn, không phải mạng chậm (gặp thật trong database).
  assert.match(
    clipErrorText('upload_put_failed[http_4xx]: http_413: {"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"} attempts=1 elapsed=2100ms'),
    /quá dung lượng để tải lên/,
  );
  assert.match(clipErrorText("upload_put_failed[timeout]: timeout after 600000ms attempts=3 elapsed=812345ms"), /mạng của kho chậm/);
});

test("mã lạ, chuỗi tiếng Anh, chuỗi rỗng → câu chung", () => {
  for (const raw of ["simulated_cut_failed", "unknown", "cut_clip failed", "", null, undefined, "constructor", "tostring"]) {
    assert.equal(clipErrorText(raw), CLIP_ERROR_GENERIC, String(raw));
  }
});

test("không có lỗi → null (ô cảnh báo ẩn)", () => {
  assert.equal(clipErrorTextOrNull(null), null);
  assert.equal(clipErrorTextOrNull(undefined), null);
  assert.equal(clipErrorTextOrNull("  "), null);
  assert.match(clipErrorTextOrNull("regeneration_failed") ?? "", /Tạo lại video không thành công/);
});

test("409 của Thử lại: hiện đúng lý do server gửi, chỉ agent_offline mới là kho offline", () => {
  assert.equal(
    retryConflictText({ error: "no_active_session", message: "Lượt quét khi chưa mở ca — không có video để cắt." }),
    "Lượt quét khi chưa mở ca — không có video để cắt.",
  );
  assert.equal(
    retryConflictText({ error: "order_still_open", message: "Đơn đang được đóng gói. Clip đầy đủ sẽ có sau khi đơn kết thúc." }),
    "Đơn đang được đóng gói. Clip đầy đủ sẽ có sau khi đơn kết thúc.",
  );
  assert.equal(retryConflictText({ error: "order_still_open" }), "Đơn đang được đóng gói, chưa cắt được clip đầy đủ.");
  assert.equal(retryConflictText({ error: "agent_offline" }), "Kho đang offline, thử lại sau khi có kết nối.");
  assert.equal(retryConflictText(null), "Kho đang offline, thử lại sau khi có kết nối.");
});

test("mọi chỗ trả lỗi clip ra giao diện đều qua bộ dịch", () => {
  const service = readFileSync("src/lib/order-proof/service.ts", "utf8");
  assert.ok(service.includes("error_message: clipErrorTextOrNull(c.error_message)"));
  assert.ok(service.includes("error_message: clipErrorText(STALE_PENDING_ERROR_MESSAGE)"));
  assert.ok(!/error_message: c\.error_message,/.test(service));

  const watch = readFileSync("src/app/api/order-proof/[pe_id]/watch/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Các nhánh nghiệp vụ trả câu đã dịch; chỉ lỗi quyền / đầu vào (4xx) giữ
  // mã cho bộ kiểm thử bảo mật — hook trình duyệt vẫn dịch chúng.
  const rawErrors = [...watch.matchAll(/state: "failed",\s*error: ([^\n]+)/g)].map((m) => m[1].trim());
  assert.ok(rawErrors.length >= 10, `chỉ thấy ${rawErrors.length} nhánh failed`);
  const allowed = new Set([
    '"packing_event_id_invalid" },',
    'status === 401 ? "unauthenticated" : "forbidden" },',
    '"packing_event_not_found" },',
    '"cross_org_access_denied" },',
  ]);
  for (const e of rawErrors) {
    assert.ok(e.startsWith("clipErrorText(") || allowed.has(e), `lỗi chưa dịch ở /watch: ${e}`);
  }
  assert.ok(watch.includes("regeneration_error: clipErrorText("));
  assert.ok(!watch.includes("[reconcile-write-failed]`"));

  const hook = readFileSync("src/lib/watch/use-watch-clip-state.ts", "utf8");
  assert.ok(hook.includes("setErrorMessage(clipErrorText(data.error))"));
  assert.ok(hook.includes("setRegenerationError(clipErrorTextOrNull(data.regeneration_error))"));
  assert.ok(hook.includes("setRegenerationError(retryConflictText(body))"));
});
