import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRevokedCameraIds } from "../src/recording-lifecycle";

/**
 * Luật thu hồi desired khi đồng bộ với cloud.
 *
 * Cọc 2026-08-05 (hik_01 kho Đại Kim): camera bị "Tạm ngưng" 31/07 nhưng
 * agent vẫn spawn ffmpeg mỗi 5 phút tới 05/08 vì không có đường nào để
 * cloud thu hồi ý định ghi. Fix mở đường đó — nhưng mở sai chiều thì hỏng
 * nặng hơn: coi lỗi mạng là "cloud không còn camera" sẽ xóa sạch desired
 * mỗi lần kho rớt mạng, và sáng hôm sau không camera nào ghi lại.
 *
 * Hai chiều đều phải đúng, nên test cả hai.
 */

const CAM_A = "8f8bb69b-b1e3-47cb-86d0-be987a0e72bb";
const CAM_B = "3a5112e0-3197-4d55-badb-efc37418612e";

test("camera vắng mặt trong response → thu hồi", () => {
  assert.deepEqual(computeRevokedCameraIds([CAM_A, CAM_B], [CAM_B]), [CAM_A]);
});

test("camera còn active → không đụng", () => {
  assert.deepEqual(computeRevokedCameraIds([CAM_A, CAM_B], [CAM_A, CAM_B]), []);
});

test("fetch fail (null) → KHÔNG thu hồi gì, kể cả desired đầy", () => {
  // Nửa âm-đúng quan trọng nhất: kho mất mạng không được làm mất desired.
  assert.deepEqual(computeRevokedCameraIds([CAM_A, CAM_B], null), []);
});

test("cloud trả rỗng thật → thu hồi toàn bộ", () => {
  // Khác hẳn null: đây là câu trả lời có thật ("org không còn camera nào
  // active"), không phải im lặng vì lỗi.
  assert.deepEqual(computeRevokedCameraIds([CAM_A, CAM_B], []), [CAM_A, CAM_B]);
});

test("desired rỗng → không có gì để thu hồi", () => {
  assert.deepEqual(computeRevokedCameraIds([], [CAM_A]), []);
  assert.deepEqual(computeRevokedCameraIds([], null), []);
});

test("cloud trả camera lạ không có trong desired → bỏ qua, không crash", () => {
  assert.deepEqual(computeRevokedCameraIds([CAM_A], [CAM_A, CAM_B]), []);
});
