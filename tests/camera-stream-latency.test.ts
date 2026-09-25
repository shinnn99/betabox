import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Bù độ trễ luồng theo từng camera khi cắt clip.
 *
 * Chủ dự án báo 25/09/2026: camera toàn cảnh luôn chậm hơn camera QR
 * khoảng 1 giây, nên clip toàn cảnh chiếu cảnh của 1 giây trước clip QR.
 *
 * Gốc: mốc quét là đồng hồ máy kho lúc giải mã xong khung hình QR
 * (`qr-frame-source.ts` gọi `onFrame(frame, new Date(), ...)`), còn đoạn
 * video đặt tên theo đồng hồ máy lúc ghi (`-strftime`). Không chỗ nào biết
 * giờ camera CHỤP được cảnh. Camera nào về chậm hơn thì đoạn của nó nằm
 * muộn hơn trên trục đồng hồ máy.
 *
 * Bù bằng MỘT con số cho mỗi camera, không phải đọc giờ in trên hình: độ
 * trễ này cố định, nên một con số là đủ và kiểm chứng được.
 */

const SQL = readFileSync(
  "supabase/migrations/20260925120000_camera_stream_latency.sql",
  "utf8",
);
const RESOLVER = readFileSync("src/lib/order-proof/clip-resolver.ts", "utf8");

test("cột lưu độ trễ có mặc định 0 và khoảng an toàn", () => {
  assert.ok(SQL.includes("ADD COLUMN IF NOT EXISTS stream_latency_ms INTEGER NOT NULL DEFAULT 0"));
  // 0 = chưa hiệu chỉnh, đúng sự thật. Đoán bừa một con số thì camera nào
  // cũng lệch một ít mà không ai biết con số ở đâu ra.
  assert.ok(SQL.includes("CHECK (stream_latency_ms BETWEEN -5000 AND 5000)"));
  // Quá ±5 giây thì không còn là độ trễ luồng mà là đồng hồ sai hoặc nghẽn
  // mạng — phải sửa gốc, không phải bù.
});

test("resolver dịch CẢ HAI đầu cửa sổ, nên độ dài clip không đổi", () => {
  assert.ok(RESOLVER.includes("clipStart = new Date(clipStart.getTime() + latencyMs)"));
  assert.ok(RESOLVER.includes("clipEnd = new Date(clipEnd.getTime() + latencyMs)"));
});

test("dịch SAU khi đã biết camera, TRƯỚC khi tìm đoạn video", () => {
  // Dịch trước khi biết camera thì không biết dịch bao nhiêu; dịch sau khi
  // đã chọn đoạn thì chọn nhầm đoạn — clip đầu hoặc cuối thiếu hình.
  const viTriCamera = RESOLVER.indexOf("// 4) Resolve camera");
  const viTriDich = RESOLVER.indexOf("const latencyMs = Number(cameraRow?.stream_latency_ms ?? 0)");
  const viTriTimDoan = RESOLVER.indexOf("const clipStartIso = clipStart.toISOString()");
  assert.ok(viTriCamera > 0 && viTriDich > 0 && viTriTimDoan > 0);
  assert.ok(viTriCamera < viTriDich, "phải biết camera trước");
  assert.ok(viTriDich < viTriTimDoan, "phải dịch trước khi tìm đoạn video");
});

test("camera chưa hiệu chỉnh thì không đụng gì tới cửa sổ", () => {
  // Cột NOT NULL DEFAULT 0, nhưng vẫn phải chịu được null (bản ghi cũ đọc
  // qua view, hoặc truy vấn lỗi trả undefined) — rơi về 0, không NaN.
  assert.ok(RESOLVER.includes("?? 0"), "thiếu giá trị thì coi như 0");
  assert.ok(
    RESOLVER.includes("Number.isFinite(latencyMs) && latencyMs !== 0"),
    "NaN hoặc 0 thì bỏ qua, không dịch",
  );
});

test("ghi rõ vì sao chỉ góc toàn cảnh lệch, góc QR thì không", () => {
  // Đây là chỗ dễ sửa nhầm nhất: người sau rất dễ tưởng phải bù cả hai
  // camera. Mốc quét sinh ra TỪ camera QR nên độ trễ của nó tự triệt tiêu.
  assert.ok(SQL.includes("clip QR    : đọc tại T + Lq → ra cảnh T          ĐÚNG"));
});
