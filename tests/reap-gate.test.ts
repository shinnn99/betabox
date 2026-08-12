import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REAP_MIN_INTERVAL_MS,
  ReapGate,
  shouldReap,
} from "../src/lib/agent-commands/reap-gate.ts";

/**
 * Cửa chặn nhịp reaper trong đường poll-commands.
 *
 * Bối cảnh: RPC reap chạy mỗi lượt poll (~20 lần/phút, đo thật từ bảng
 * nonce) để canh ngưỡng 2 phút. Mỗi lượt là một round-trip PostgREST ghi
 * → egress Database.
 *
 * Hai vế phải giữ:
 *   - dương: quá hạn thì PHẢI chạy (không được bóp tới mức bỏ sót).
 *   - âm: trong hạn thì KHÔNG được chạy (nếu không thì vá này vô nghĩa).
 */

const AGENT_A = "abf5339a-2f19-4547-86db-4eb3165f22b6";
const AGENT_B = "dc4bdb26-9e51-4d53-be57-65baacbb3a68";
const T0 = Date.parse("2026-08-12T03:00:00.000Z");

test("lần đầu trong tiến trình → luôn chạy", () => {
  assert.equal(shouldReap(undefined, T0), true);
});

test("nửa âm: trong hạn → KHÔNG chạy", () => {
  assert.equal(shouldReap(T0, T0 + REAP_MIN_INTERVAL_MS - 1), false);
});

test("nửa dương: đúng hạn và quá hạn → chạy", () => {
  assert.equal(shouldReap(T0, T0 + REAP_MIN_INTERVAL_MS), true);
  assert.equal(shouldReap(T0, T0 + REAP_MIN_INTERVAL_MS * 10), true);
});

test("gate: lượt đầu mở, các lượt poll dồn ngay sau đó bị chặn", () => {
  const gate = new ReapGate();
  assert.equal(gate.tryAcquire(AGENT_A, T0), true);
  // Poll 3 giây một lần → 4 lượt kế trong cửa 15s đều phải bị chặn.
  for (let i = 1; i <= 4; i++) {
    assert.equal(
      gate.tryAcquire(AGENT_A, T0 + i * 3000),
      false,
      `lượt poll thứ ${i} (t+${i * 3}s) phải bị chặn`,
    );
  }
  assert.equal(gate.tryAcquire(AGENT_A, T0 + REAP_MIN_INTERVAL_MS), true);
});

test("mỗi agent đếm riêng — agent B không bị agent A chặn", () => {
  const gate = new ReapGate();
  assert.equal(gate.tryAcquire(AGENT_A, T0), true);
  assert.equal(gate.tryAcquire(AGENT_B, T0), true);
  assert.equal(gate.tryAcquire(AGENT_B, T0 + 1000), false);
});

test("tiến trình mới (restart / instance thứ hai) → reap NGAY, không bỏ sót", () => {
  // Mô phỏng cách hỏng duy nhất của việc giữ mốc trong RAM: mốc mất thì
  // reap nhiều hơn, KHÔNG BAO GIỜ thưa hơn. Đây là lý do dùng RAM ở đây
  // an toàn, khác ca debounce/rate-limit.
  const instance1 = new ReapGate();
  assert.equal(instance1.tryAcquire(AGENT_A, T0), true);
  const instance2 = new ReapGate();
  assert.equal(instance2.tryAcquire(AGENT_A, T0 + 1), true);
});

test("hằng số phải nhỏ hơn ngưỡng ping trong RPC (bẫy trôi hợp đồng)", () => {
  // RPC reap_stale_agent_commands đặt visibility timeout theo type:
  // 'ping' 30 giây, còn lại 2 phút. Cửa chặn LỚN HƠN ngưỡng nhỏ nhất
  // nghĩa là lệnh chết bị phát hiện muộn hơn chính ngưỡng nó canh.
  // Test này đọc thẳng migration để không phải nhớ bằng đầu.
  const sql = readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "supabase",
      "migrations",
      "20260701092259_agent_commands.sql",
    ),
    "utf8",
  );
  const m = sql.match(/when 'ping' then interval '(\d+) seconds'/);
  assert.ok(m, "không tìm thấy ngưỡng ping trong migration — RPC đã đổi?");
  const pingTimeoutMs = Number(m[1]) * 1000;
  assert.ok(
    REAP_MIN_INTERVAL_MS < pingTimeoutMs,
    `REAP_MIN_INTERVAL_MS (${REAP_MIN_INTERVAL_MS}ms) phải nhỏ hơn ngưỡng ping (${pingTimeoutMs}ms)`,
  );
});
