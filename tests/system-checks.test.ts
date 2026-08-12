import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_KEYS,
  checkAgentHeartbeat,
  checkCameraProbe,
  checkCronCleanup,
  checkEgress,
  checkVpsResources,
  checkWarehouseDisk,
  runSystemChecks,
  worstStatus,
  type SystemCheck,
} from "../src/lib/system/checks.ts";

/**
 * Sáu mục kiểm hạ tầng: mỗi mục kiểm 4 ca — ok, warn, crit, và nguồn dữ
 * liệu hỏng.
 *
 * Ca thứ tư là ca dễ bị bỏ nhất và cũng là ca nguy nhất: nếu nguồn hỏng mà
 * mục kiểm ném ngoại lệ thì route cảnh báo chết, và lúc đó hệ mất luôn
 * đường báo động — đúng lúc hạ tầng đang có chuyện. Mọi ca nguồn-hỏng dưới
 * đây phải ra `unknown`, không được ném.
 */

const NOW = new Date("2026-08-12T10:00:00Z");

// ── Supabase client giả ────────────────────────────────────────────────
// Mọi bước chain đều ghi lại rồi trả chính nó; `resolve` quyết định kết
// quả dựa trên tên bảng + các bước đã gọi (nhờ vậy phân biệt được 2 truy
// vấn khác nhau trên cùng bảng system_jobs).

interface Op {
  method: string;
  args: unknown[];
}
type Resolver = (table: string, ops: Op[]) => { data: unknown; error: unknown };

const CHAIN = ["select", "eq", "gte", "order", "limit", "in", "not", "abortSignal", "insert"];

function fakeDb(resolve: Resolver) {
  return {
    from(table: string) {
      const ops: Op[] = [];
      const q: Record<string, unknown> = {
        then: (res: (v: unknown) => void) => res(resolve(table, ops)),
      };
      for (const m of CHAIN) {
        q[m] = (...args: unknown[]) => {
          ops.push({ method: m, args });
          return q;
        };
      }
      return q;
    },
  };
}

function hasEq(ops: Op[], col: string, val?: unknown): boolean {
  return ops.some(
    (o) => o.method === "eq" && o.args[0] === col && (val === undefined || o.args[1] === val),
  );
}

const BOOM: Resolver = () => ({ data: null, error: { message: "connection reset" } });

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

/** Chạy một mục kiểm qua runSystemChecks để có luôn lớp bọc safeCheck. */
async function runOne(key: string, resolve: Resolver): Promise<SystemCheck> {
  const checks = await runSystemChecks({
    client: fakeDb(resolve) as never,
    now: NOW,
    os: { totalmem: () => 8 * 1024 ** 3, freemem: () => 4 * 1024 ** 3 },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
  });
  const found = checks.find((c) => c.key === key);
  assert.ok(found, `không tìm thấy mục ${key}`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Egress Supabase — chưa có nguồn, mọi lúc đều unknown
// ═══════════════════════════════════════════════════════════════════════

test("egress: unknown và nói rõ CHƯA CÓ NGUỒN, không bịa số", () => {
  const c = checkEgress();
  assert.equal(c.key, CHECK_KEYS.egress);
  assert.equal(c.status, "unknown");
  assert.match(c.message, /Chưa có nguồn dữ liệu/);
  // Không được lỡ tay ra ok — ô xanh ở đây nghĩa là "egress ổn", sai sự thật.
  assert.notEqual(c.status, "ok");
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Cron dọn clip
// ═══════════════════════════════════════════════════════════════════════

/** Trả dòng cho cả 2 truy vấn: lần-chạy-xong gần nhất và dòng mới nhất. */
function cronDb(lastOk: string | null, latest: { ran_at: string; ok: boolean } | null): Resolver {
  return (table, ops) => {
    if (table !== "system_jobs") return { data: [], error: null };
    if (hasEq(ops, "ok", true)) {
      return { data: lastOk ? [{ ran_at: lastOk, ok: true }] : [], error: null };
    }
    return { data: latest ? [latest] : [], error: null };
  };
}

test("cron: ca ok — chạy xong 2 giờ trước", async () => {
  const c = await runOne(CHECK_KEYS.cronCleanup, cronDb(hoursAgo(2), { ran_at: hoursAgo(2), ok: true }));
  assert.equal(c.status, "ok");
  assert.match(c.value, /2 giờ/);
});

test("cron: ca warn — lỡ một nhịp (30 giờ > 26h)", async () => {
  const c = await runOne(CHECK_KEYS.cronCleanup, cronDb(hoursAgo(30), { ran_at: hoursAgo(30), ok: true }));
  assert.equal(c.status, "warn");
});

test("cron: ca crit — 60 giờ, đúng kịch bản chết âm thầm 5 ngày", async () => {
  const c = await runOne(CHECK_KEYS.cronCleanup, cronDb(hoursAgo(60), { ran_at: hoursAgo(60), ok: true }));
  assert.equal(c.status, "crit");
});

test("cron: ca crit — chưa có dòng nào (timer chưa từng chạy)", async () => {
  const c = await runOne(CHECK_KEYS.cronCleanup, cronDb(null, null));
  assert.equal(c.status, "crit");
  assert.match(c.message, /systemd timer/);
});

test("cron: chạy đều nhưng lần cuối LỖI → warn, không xanh giả", async () => {
  // Bẫy: chỉ đo tuổi dòng mới nhất thì ca này xanh — cron chạy đúng giờ
  // nhưng lần nào cũng thất bại.
  const c = await runOne(CHECK_KEYS.cronCleanup, cronDb(hoursAgo(2), { ran_at: hoursAgo(1), ok: false }));
  assert.equal(c.status, "warn");
  assert.match(c.message, /THẤT BẠI/);
});

test("cron: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.cronCleanup, BOOM);
  assert.equal(c.status, "unknown");
  assert.match(c.message, /connection reset/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Heartbeat agent
// ═══════════════════════════════════════════════════════════════════════

function agentDb(rows: Array<{ code: string; last_seen_at: string | null }>): Resolver {
  return (table) => (table === "warehouse_agents" ? { data: rows, error: null } : { data: [], error: null });
}

test("agent: ca ok — ping 5 phút trước", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: minutesAgo(5) }]));
  assert.equal(c.status, "ok");
});

test("agent: ca warn — im 45 phút", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: minutesAgo(45) }]));
  assert.equal(c.status, "warn");
  assert.match(c.value, /KHO-A/);
});

test("agent: ca crit — im 19 giờ, đúng sự cố đã xảy ra", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: hoursAgo(19) }]));
  assert.equal(c.status, "crit");
  assert.match(c.value, /19 giờ/);
});

test("agent: agent im lâu nhất quyết định, không bị agent khoẻ che", async () => {
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([
      { code: "KHO-A", last_seen_at: minutesAgo(1) },
      { code: "KHO-B", last_seen_at: hoursAgo(5) },
      { code: "KHO-C", last_seen_at: minutesAgo(2) },
    ]),
  );
  assert.equal(c.status, "crit");
  assert.match(c.value, /KHO-B/);
});

test("agent: chưa từng kết nối (last_seen_at null) → crit", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-MOI", last_seen_at: null }]));
  assert.equal(c.status, "crit");
  assert.match(c.message, /chưa từng gửi heartbeat/);
});

test("agent: không có agent active → unknown chứ không phải ok", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([]));
  assert.equal(c.status, "unknown");
});

test("agent: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, BOOM);
  assert.equal(c.status, "unknown");
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Camera probe
// ═══════════════════════════════════════════════════════════════════════

function cameraDb(
  rows: Array<{ camera_code: string; last_probe_at: string | null; probe_consecutive_fails: number }>,
): Resolver {
  return (table) => (table === "cameras" ? { data: rows, error: null } : { data: [], error: null });
}

test("camera: ca ok — không camera nào lỗi", async () => {
  const c = await runOne(CHECK_KEYS.cameraProbe, cameraDb([]));
  assert.equal(c.status, "ok");
});

test("camera: vừa lỗi vài phút → vẫn ok (chưa quá 2 giờ)", async () => {
  // 10 nhịp × 30s = 5 phút.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-1", last_probe_at: minutesAgo(1), probe_consecutive_fails: 10 }]),
  );
  assert.equal(c.status, "ok");
});

test("camera: ca warn — lỗi liên tục 2.5 giờ (300 nhịp × 30s)", async () => {
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-1", last_probe_at: minutesAgo(1), probe_consecutive_fails: 300 }]),
  );
  assert.equal(c.status, "warn");
  assert.match(c.message, /CAM-1/);
});

test("camera: probe cũ (agent không còn probe) → unknown, KHÔNG đỏ vĩnh viễn", async () => {
  // Camera ngừng ghi giữ last_probe_ok=false mãi mãi. Đếm nhóm này là tự
  // tạo ra một ô đỏ không bao giờ tắt, và người trực sẽ học cách phớt lờ.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-CU", last_probe_at: hoursAgo(30), probe_consecutive_fails: 5000 }]),
  );
  assert.equal(c.status, "unknown");
  assert.match(c.message, /số liệu.*cũ|probe cũ/);
});

test("camera: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.cameraProbe, BOOM);
  assert.equal(c.status, "unknown");
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Disk + RAM VPS
// ═══════════════════════════════════════════════════════════════════════

function vps(diskUsedPct: number, ramUsedPct: number) {
  const blocks = 1000;
  return {
    now: NOW,
    os: {
      totalmem: () => 8 * 1024 ** 3,
      freemem: () => 8 * 1024 ** 3 * (1 - ramUsedPct / 100),
    },
    statfs: async () => ({ bsize: 4096, blocks, bavail: blocks * (1 - diskUsedPct / 100) }),
    path: "/srv/betabox",
  };
}

test("vps: ca ok — disk 50%, RAM 50%", async () => {
  const c = await checkVpsResources(vps(50, 50));
  assert.equal(c.status, "ok");
  assert.match(c.value, /Disk 50%/);
});

test("vps: ca warn — disk 90% (>85)", async () => {
  const c = await checkVpsResources(vps(90, 40));
  assert.equal(c.status, "warn");
});

test("vps: ca crit — disk 96% (>95)", async () => {
  const c = await checkVpsResources(vps(96, 40));
  assert.equal(c.status, "crit");
});

test("vps: RAM cũng kích được warn/crit, không chỉ disk", async () => {
  assert.equal((await checkVpsResources(vps(10, 92))).status, "warn");
  assert.equal((await checkVpsResources(vps(10, 98))).status, "crit");
});

test("vps: dùng bavail (block cho user thường), không phải toàn bộ block trống", async () => {
  // Linux giữ ~5% cho root. Nếu tính theo bfree, ổ đã hết chỗ ghi vẫn báo
  // còn trống. Ở đây bavail=0 → phải là 100% dùng, crit.
  const c = await checkVpsResources({
    now: NOW,
    os: { totalmem: () => 100, freemem: () => 90 },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 0 }),
  });
  assert.equal(c.status, "crit");
  assert.match(c.value, /Disk 100%/);
});

test("vps: ca nguồn hỏng — statfs ném → unknown, KHÔNG ném ra ngoài", async () => {
  const checks = await runSystemChecks({
    client: fakeDb(() => ({ data: [], error: null })) as never,
    now: NOW,
    os: { totalmem: () => 8, freemem: () => 4 },
    statfs: async () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  const c = checks.find((x) => x.key === CHECK_KEYS.vps)!;
  assert.equal(c.status, "unknown");
  assert.match(c.message, /ENOENT/);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Disk máy kho — chưa có nguồn
// ═══════════════════════════════════════════════════════════════════════

test("disk kho: unknown và nói rõ agent chưa gửi dữ liệu này", () => {
  const c = checkWarehouseDisk();
  assert.equal(c.status, "unknown");
  assert.match(c.message, /Chưa có nguồn dữ liệu/);
  assert.match(c.message, /heartbeat/);
});

// ═══════════════════════════════════════════════════════════════════════
// Toàn loạt
// ═══════════════════════════════════════════════════════════════════════

test("runSystemChecks: luôn trả đủ 6 mục, đúng thứ tự cố định", async () => {
  const checks = await runSystemChecks({
    client: fakeDb(BOOM) as never,
    now: NOW,
    os: { totalmem: () => 8, freemem: () => 4 },
    statfs: async () => {
      throw new Error("hỏng luôn");
    },
  });
  assert.deepEqual(
    checks.map((c) => c.key),
    [
      CHECK_KEYS.egress,
      CHECK_KEYS.cronCleanup,
      CHECK_KEYS.agentHeartbeat,
      CHECK_KEYS.cameraProbe,
      CHECK_KEYS.vps,
      CHECK_KEYS.warehouseDisk,
    ],
  );
  // Hỏng TOÀN BỘ nguồn dữ liệu vẫn phải trả về 6 mục, không ném.
  assert.ok(checks.every((c) => c.status === "unknown"));
});

test("runSystemChecks: thiếu env Supabase → unknown, không ném", async () => {
  const checks = await runSystemChecks({
    client: undefined,
    now: NOW,
    os: { totalmem: () => 8, freemem: () => 4 },
    statfs: async () => ({ bsize: 4096, blocks: 10, bavail: 5 }),
  });
  const cron = checks.find((c) => c.key === CHECK_KEYS.cronCleanup)!;
  assert.equal(cron.status, "unknown");
  assert.match(cron.message, /Supabase/);
});

test("worstStatus: crit > warn > unknown > ok", () => {
  const mk = (status: SystemCheck["status"]): SystemCheck => ({ key: "k", status, value: "", message: "" });
  assert.equal(worstStatus([mk("ok"), mk("warn"), mk("crit")]), "crit");
  assert.equal(worstStatus([mk("ok"), mk("warn"), mk("unknown")]), "warn");
  assert.equal(worstStatus([mk("ok"), mk("unknown")]), "unknown");
  assert.equal(worstStatus([mk("ok"), mk("ok")]), "ok");
});

// Gọi trực tiếp (không qua safeCheck) để chứng minh lớp bọc là thứ biến
// lỗi thành unknown, chứ không phải hàm tự nuốt lỗi trong im lặng.
test("nửa âm: gọi thẳng checkCronCleanup với nguồn hỏng thì NÉM — safeCheck mới là lớp bọc", async () => {
  await assert.rejects(
    () => checkCronCleanup(fakeDb(BOOM) as never, NOW),
    /connection reset/,
  );
});

test("nửa âm: gọi thẳng checkAgentHeartbeat/checkCameraProbe với nguồn hỏng thì NÉM", async () => {
  await assert.rejects(() => checkAgentHeartbeat(fakeDb(BOOM) as never, NOW), /connection reset/);
  await assert.rejects(() => checkCameraProbe(fakeDb(BOOM) as never, NOW), /connection reset/);
});
