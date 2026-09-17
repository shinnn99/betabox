import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalBackend,
  parseDevLockPort,
  resolveBackendUrl,
  withPort,
} from "../src/backend-url";

const LOCK = (port: number) =>
  JSON.stringify({ pid: 123, port, hostname: "localhost", appUrl: `http://localhost:${port}` });

/** Giả lập: chỉ đúng một URL trả lời. */
const only = (ok: string) => async (url: string) => url === ok;

test("nhận ra backend chạy nội bộ", () => {
  assert.equal(isLocalBackend("https://localhost:3000"), true);
  assert.equal(isLocalBackend("http://127.0.0.1:3001"), true);
  assert.equal(isLocalBackend("https://betabox.betacom.agency"), false);
  assert.equal(isLocalBackend("khong-phai-url"), false);
});

test("đổi cổng nhưng giữ nguyên scheme và host", () => {
  assert.equal(withPort("https://localhost:3000", 3002), "https://localhost:3002");
});

test("đọc được cổng trong file lock của Next", () => {
  assert.equal(parseDevLockPort(LOCK(3002)), 3002);
  assert.equal(parseDevLockPort("{}"), null);
  assert.equal(parseDevLockPort("khong phai json"), null);
});

// ---------------------------------------------------------------------------
// Ràng buộc quan trọng nhất: production KHÔNG được dò cổng. Agent tự nối
// sang một máy chủ khác là chuyện không bao giờ được xảy ra ngoài kho.
// ---------------------------------------------------------------------------
test("URL production giữ nguyên, không dò gì hết", async () => {
  let probed = false;
  const r = await resolveBackendUrl({
    configured: "https://betabox.betacom.agency",
    probe: async () => {
      probed = true;
      return false;
    },
  });
  assert.deepEqual(r, { url: "https://betabox.betacom.agency", source: "remote" });
  assert.equal(probed, false, "không được gõ cửa bất kỳ cổng nào ở production");
});

test("cổng đang cấu hình còn sống thì dùng luôn, không đổi", async () => {
  const r = await resolveBackendUrl({
    configured: "https://localhost:3000",
    probe: only("https://localhost:3000"),
    readLock: async () => LOCK(3005),
  });
  assert.deepEqual(r, { url: "https://localhost:3000", source: "configured" });
});

test("cổng cũ chết thì theo cổng ghi trong file lock", async () => {
  const r = await resolveBackendUrl({
    configured: "https://localhost:3000",
    probe: only("https://localhost:3002"),
    readLock: async () => LOCK(3002),
  });
  assert.deepEqual(r, { url: "https://localhost:3002", source: "dev-lock" });
});

test("không có file lock thì dò lần lượt các cổng quen thuộc", async () => {
  const r = await resolveBackendUrl({
    configured: "https://localhost:3000",
    probe: only("https://localhost:3003"),
    readLock: async () => {
      throw new Error("khong co file");
    },
  });
  assert.deepEqual(r, { url: "https://localhost:3003", source: "probe" });
});

test("file lock chỉ sai chứ không phá: vẫn dò tiếp và tìm ra", async () => {
  const r = await resolveBackendUrl({
    configured: "https://localhost:3000",
    probe: only("https://localhost:3001"),
    readLock: async () => LOCK(3999),
  });
  assert.deepEqual(r, { url: "https://localhost:3001", source: "probe" });
});

test("không cổng nào trả lời thì giữ URL cũ để còn thử lại", async () => {
  const r = await resolveBackendUrl({
    configured: "https://localhost:3000",
    probe: async () => false,
    readLock: async () => LOCK(3002),
  });
  assert.deepEqual(r, { url: "https://localhost:3000", source: "unreachable" });
});
