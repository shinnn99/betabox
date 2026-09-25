import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Tìm đoạn video để cắt clip — hai lỗi đã cắn thật ở kho Đại Kim 25/09/2026.
 *
 * Triệu chứng: mọi clip của đơn từ 21/09 trở về trước đều không tải được,
 * kèm thông báo "Video đã quá hạn lưu trữ (giữ 30 ngày)" — trong khi đơn
 * mới 8 ngày và đoạn video vẫn nằm trên ổ máy kho.
 *
 * Nguyên nhân 1 — LỌC THEO MÃ MÁY KHO BẰNG DẤU BẰNG. Cột `agent_id` chỉ
 * được agent gửi kèm từ 22/09/2026; 5.724 bản ghi trước đó để trống. Trong
 * SQL, `agent_id = '...'` KHÔNG BAO GIỜ khớp NULL, nên mọi đoạn cũ biến
 * mất khỏi kết quả và hàm kết luận "không có đoạn nào".
 *
 * Nguyên nhân 2 — ĐOÁN BỪA "QUÁ HẠN". Khi không tìm thấy đoạn, hàm hỏi
 * "camera này có bản ghi nào cũ hơn hạn lưu không?". Camera nào chạy lâu
 * cũng có, nên câu trả lời luôn là "có" → luôn báo quá hạn, che mất
 * nguyên nhân thật. Phải hỏi về CHÍNH đơn đang xét.
 */

const SOURCE = readFileSync("src/lib/order-proof/clip-resolver.ts", "utf8");

test("bản ghi thiếu mã máy kho vẫn được nhận, không bị lọc bỏ", () => {
  assert.ok(
    SOURCE.includes("agent_id.is.null,agent_id.eq."),
    "phải nhận cả bản ghi có agent_id NULL (bản ghi cũ trước 22/09/2026)",
  );
  assert.ok(
    !/filesQuery\s*=\s*filesQuery\.eq\("agent_id"/.test(SOURCE),
    'không được lọc agent_id bằng .eq() — NULL sẽ không khớp và mọi đoạn cũ biến mất',
  );
});

test('chỉ nói "quá hạn lưu trữ" khi CHÍNH đơn đó cũ hơn hạn lưu', () => {
  assert.ok(
    SOURCE.includes("clipEnd.getTime() < retentionCutoffMs"),
    "điều kiện phải so ngày của đơn với hạn lưu",
  );
  // Luật cũ: tìm xem camera có bản ghi nào cũ hơn hạn lưu không.
  assert.ok(
    !SOURCE.includes(".lt(\"started_at\", retentionCutoffIso)"),
    "bỏ hẳn luật đoán theo bản ghi cũ nhất của camera",
  );
  const block = SOURCE.slice(
    SOURCE.indexOf("if (retentionDays !== null)"),
    SOURCE.indexOf('reason: "no_segments"'),
  );
  assert.ok(
    !block.includes("oldRows"),
    "không được dựa vào việc camera có bản ghi cũ để kết luận quá hạn",
  );
});

test("không tìm thấy đoạn thì nói thật, không đổ cho hạn lưu trữ", () => {
  assert.ok(
    SOURCE.includes("Không tìm thấy đoạn video nào cho khoảng thời gian đóng đơn này"),
    "thông báo phải nói đúng bản chất",
  );
  assert.ok(
    SOURCE.includes("đã bị xoá / chuyển chỗ trên máy kho"),
    "nêu luôn khả năng file bị chuyển chỗ — đúng tình huống đã xảy ra",
  );
});
