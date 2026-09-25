import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Lượt quét có cửa sổ làm việc 0 giây không được hiện ở trang Bằng chứng,
 * và không được cắt clip.
 *
 * Chủ dự án báo 25/09/2026 (ảnh một dòng ngày 23/09): mã `TTVN1099351268`,
 * "Không có ca", "0s", "Chưa có", kèm nút Tạo clip — "mấy cái nào mà 0 giây
 * thì đừng có cho vào".
 *
 * Đây là kiện hoàn NGHI VẤN (`return_suspect`): lưới an toàn thấy một mã đã
 * gửi đi bị quét lại ở bàn đóng hàng. Không có phiên làm việc nào để lấy
 * mốc, nên `process_waybill_scan` ghi `bắt đầu = kết thúc = giờ quét` →
 * cửa sổ 0 giây. Bấm Tạo clip thì ffmpeg nhận khoảng rỗng.
 *
 * KHÔNG xoá mấy dòng này khỏi database: mã là mã vận đơn THẬT, và việc "mã
 * đã gửi đi bị quét lại" đúng là thứ cần biết. Chúng vẫn nằm ở "Cần xử lý"
 * và trong nhật ký — chỗ đó mới đúng việc của chúng. Chỉ bỏ khỏi trang
 * Bằng chứng, nơi chúng không có gì để chứng minh.
 */

test("danh sách bằng chứng loại cửa sổ 0 giây", () => {
  const src = readFileSync("src/lib/order-proof/service.ts", "utf8");
  assert.ok(
    src.includes(`q.or("work_duration_seconds.is.null,work_duration_seconds.gt.0")`),
    "phải lọc theo số giây ngay trong truy vấn",
  );
});

test("giữ lại dòng chưa có số giây — đó là kiện đang mở", () => {
  // Lọc bằng `neq 0` là rơi mất luôn dòng NULL (so sánh với NULL ra NULL),
  // tức là kiện hoàn đang mở biến mất khỏi trang ngay khi vừa quét.
  const src = readFileSync("src/lib/order-proof/service.ts", "utf8");
  assert.ok(src.includes("work_duration_seconds.is.null"), "phải giữ dòng NULL");
  assert.ok(
    !src.includes(`.neq("work_duration_seconds", 0)`),
    "không được dùng neq — mất dòng NULL",
  );
});

test("không cho cắt clip cho cửa sổ 0 giây", () => {
  const src = readFileSync("src/lib/agent-commands/enqueue.ts", "utf8");
  assert.ok(src.includes(`| "zero_length_window"`), "phải có mã lỗi riêng");
  assert.ok(
    src.includes("new Date(pe.work_ended_at).getTime() <= new Date(pe.work_started_at).getTime()"),
    "chặn khi kết thúc không sau bắt đầu",
  );
  // Chặn TRƯỚC khi dò camera và tìm đoạn video, không thì vẫn tốn một
  // vòng hỏi database rồi mới bỏ.
  const viTriChan = src.indexOf(`reason: "zero_length_window"`);
  const viTriCamera = src.indexOf("resolveAssignedCameraByRole", viTriChan - 4000);
  assert.ok(viTriChan > 0 && viTriChan < src.indexOf("const overviewCameraId"));
  assert.ok(viTriCamera !== 0);
});

test("người dùng đọc được lý do, không phải mã lỗi thô", () => {
  const route = readFileSync("src/app/api/order-proof/[pe_id]/watch/route.ts", "utf8");
  assert.ok(route.includes(`cutResult.reason === "zero_length_window"`));
  assert.ok(route.includes("không có khoảng thời gian làm việc (0 giây)"));
});
