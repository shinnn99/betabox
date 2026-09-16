import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProofClipFileName,
  sanitizeWaybillForFileName,
} from "../src/lib/order-proof/clip-file-name.ts";

test("tên file theo đúng mẫu mã vận đơn - ngày - giờ", () => {
  // 2026-09-16T04:12:55Z = 11:12:55 giờ VN.
  assert.equal(
    buildProofClipFileName({
      waybillCode: "SPXVN062307014218",
      scannedAt: "2026-09-16T04:12:55.059+00:00",
    }),
    "SPXVN062307014218-20260916-111255.mp4",
  );
});

test("đổi ngày theo giờ VN chứ không theo UTC", () => {
  // 17:30 UTC = 00:30 hôm sau ở VN — ngày trong tên file phải là hôm sau.
  assert.equal(
    buildProofClipFileName({
      waybillCode: "ABC123",
      scannedAt: "2026-09-16T17:30:00.000Z",
    }),
    "ABC123-20260917-003000.mp4",
  );
});

test("ký tự lạ trong mã vận đơn bị thay, không làm hỏng tên file", () => {
  assert.equal(sanitizeWaybillForFileName("SPX/VN 062\\307"), "SPX-VN-062-307");
  assert.equal(sanitizeWaybillForFileName("  ..A..  "), "..A..");
  assert.equal(sanitizeWaybillForFileName("###"), "don-khong-ma");
  assert.equal(sanitizeWaybillForFileName(null), "don-khong-ma");
});

test("đơn không có mã vẫn ra tên file hợp lệ", () => {
  assert.equal(
    buildProofClipFileName({ waybillCode: "", scannedAt: "2026-09-16T04:12:55Z" }),
    "don-khong-ma-20260916-111255.mp4",
  );
});

test("thời gian hỏng thì vẫn giữ được mã đơn trong tên", () => {
  assert.equal(
    buildProofClipFileName({ waybillCode: "SPXVN1", scannedAt: "không-phải-ngày" }),
    "SPXVN1.mp4",
  );
  assert.equal(
    buildProofClipFileName({ waybillCode: "SPXVN1", scannedAt: null }),
    "SPXVN1.mp4",
  );
});

test("sinh lại clip cho cùng một đơn luôn ra cùng một tên", () => {
  const a = buildProofClipFileName({
    waybillCode: "SPXVN1",
    scannedAt: "2026-09-16T04:12:55.059+00:00",
  });
  const b = buildProofClipFileName({
    waybillCode: "SPXVN1",
    scannedAt: new Date("2026-09-16T04:12:55.059+00:00"),
  });
  assert.equal(a, b);
});
