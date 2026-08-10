import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../warehouse-agent/src/config.ts";

/**
 * Nhịp gọi mạng của agent — chốt bằng số, không bằng trí nhớ.
 *
 * Chạy: pnpm test
 *
 * Mỗi con số dưới đây nhân với 43.200 phút/tháng ra thẳng hoá đơn Vercel
 * cho MỖI agent chạy 24/7. Tháng 8/2026 tài khoản bị khoá vì vượt cả bốn
 * hạn mức, nên đổi một trong các số này là quyết định có hậu quả tiền bạc,
 * phải cố ý và phải sửa cả test này.
 *
 * Ranh giới quan trọng: poll-commands GIỮ 3 giây. Đó là đường lệnh
 * Bắt đầu/Dừng ghi từ dashboard xuống agent; kéo dài ra là đổi tiền lấy
 * độ trễ ngay trước mặt người vận hành kho. Cắt request phải cắt ở chỗ
 * khác — và đã cắt ở discovery (15s → 60s) cùng việc gộp lượt xin danh
 * sách camera vào phản hồi probe.
 */

function configWithEnv(overrides: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    BACKEND_URL: "https://example.test",
    AGENT_CODE: "AG-TEST",
    AGENT_SECRET: "secret-at-least-8",
    ...overrides,
  });
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
}

test("poll-commands giữ 3 giây — không đánh đổi độ trễ lệnh ghi hình", () => {
  assert.equal(configWithEnv().pollIntervalMs, 3000);
});

test("discovery 60 giây — cổng COM chỉ đổi khi có người cắm dây", () => {
  // 15s cũ tốn 172.800 request/tháng để nghe lại đúng câu trả lời cũ.
  assert.equal(configWithEnv().discoveryIntervalMs, 60_000);
});

test("heartbeat giữ 30 giây", () => {
  assert.equal(configWithEnv().heartbeatIntervalMs, 30_000);
});

test("camera probe giữ 30 giây — độ trễ phát hiện camera offline không đổi", () => {
  assert.equal(configWithEnv().cameraProbeIntervalMs, 30_000);
});

test("mọi nhịp vẫn override được qua env cho kho có nhu cầu khác", () => {
  const cfg = configWithEnv({
    DISCOVERY_INTERVAL_MS: "120000",
    POLL_INTERVAL_MS: "5000",
  });
  assert.equal(cfg.discoveryIntervalMs, 120_000);
  assert.equal(cfg.pollIntervalMs, 5000);
});

/**
 * Ngân sách request/tháng của MỘT agent chạy 24/7.
 *
 * Con số này là lý do đợt tối ưu vẫn chưa đủ để về lại Hobby: giữ
 * poll-commands ở 3 giây thì riêng nó đã 864.000 request/tháng, và một
 * agent tổng cộng vượt trần 1 triệu của Hobby TRƯỚC KHI có ai mở dashboard.
 * Đó là đánh đổi đã chốt — độ trễ lệnh ghi hình đáng giá hơn tiền gói Pro.
 *
 * Muốn một agent về dưới 1 triệu thì phải làm adaptive backoff cho
 * poll-commands (đang hoãn, chờ số liệu production 24-48h). Test này để
 * lần đó có mốc so, và để không ai tưởng nhầm là đã xong.
 */
test("ngân sách request/tháng của một agent 24/7 — đúng như đã tính", () => {
  const cfg = configWithEnv();
  const MS_PER_MONTH = 30 * 24 * 60 * 60_000;
  const perMonth = (intervalMs: number, callsPerTick = 1) =>
    (MS_PER_MONTH * callsPerTick) / intervalMs;

  const poll = perMonth(cfg.pollIntervalMs);
  const discovery = perMonth(cfg.discoveryIntervalMs);
  const heartbeat = perMonth(cfg.heartbeatIntervalMs);
  // Sau khi gộp: MỘT request mỗi nhịp probe, không phải hai.
  const probe = perMonth(cfg.cameraProbeIntervalMs, 1);

  assert.equal(poll, 864_000);
  assert.equal(discovery, 43_200); // trước: 172.800
  assert.equal(heartbeat, 86_400);
  assert.equal(probe, 86_400); // trước: 172.800 (hai lượt gọi mỗi nhịp)

  const total = poll + discovery + heartbeat + probe;
  assert.equal(total, 1_080_000, "trước đợt tối ưu: 1.296.000");

  // Ghi thẳng ra đây để không ai đọc lướt rồi tưởng đã về dưới trần Hobby.
  assert.ok(
    total > 1_000_000,
    "nếu số này xuống dưới 1 triệu thì poll-commands đã bị kéo dài — sửa cả chú thích ở trên",
  );
  assert.ok(
    poll / total > 0.79,
    "poll-commands vẫn phải là phần áp đảo; nếu không, chỗ cần tối ưu đã đổi",
  );
});
