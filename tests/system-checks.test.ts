import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_KEYS,
  checkAgentHeartbeat,
  checkCameraProbe,
  checkCronCleanup,
  checkEgress,
  checkStorageUsage,
  checkVpsResources,
  checkWarehouseDisk,
  incidentUnknowns,
  needsAlert,
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

function findIn(ops: Op[], col: string): unknown[] | null {
  const op = ops.find((o) => o.method === "in" && o.args[0] === col);
  return op ? (op.args[1] as unknown[]) : null;
}

const BOOM: Resolver = () => ({ data: null, error: { message: "connection reset" } });

// ── Phạm vi theo dõi ───────────────────────────────────────────────────
// Mọi mục kiểm bám agent/camera đều hỏi `organizations`, `warehouses` và
// `packing_events` trước.
//
// MẶC ĐỊNH CỦA TEST: đơn cuối được quét NGAY LÚC NOW. Chọn vậy có chủ đích
// — nó mô phỏng "kho đang làm việc", nên mọi ca cũ (agent im 45 phút, im 19
// giờ…) giữ nguyên ý nghĩa: bao nhiêu im lặng cũng là bấy nhiêu bằng chứng
// đã mất. Ca "kho nghỉ" phải khai `lastScan` riêng, xem SCOPE_CLOSED.

const ORG = "org-1";

interface ScopeOpts {
  orgs?: Array<{ id: string; name: string }>;
  warehouses?: Array<{ organization_id: string; name: string }>;
  /** Mốc đơn cuối theo org. Thiếu key = dùng mặc định (đang làm việc). */
  lastScan?: Record<string, string | null>;
}

/** Bọc một resolver: tự trả lời 3 bảng phạm vi, còn lại giao cho `inner`. */
function withScope(inner: Resolver, opts: ScopeOpts = {}): Resolver {
  const orgs = opts.orgs ?? [{ id: ORG, name: "Kho A" }];
  const warehouses = opts.warehouses ?? [];
  return (table, ops) => {
    if (table === "organizations") return { data: orgs, error: null };
    if (table === "warehouses") return { data: warehouses, error: null };
    if (table === "packing_events") {
      const eq = ops.find((o) => o.method === "eq" && o.args[0] === "organization_id");
      const orgId = eq ? String(eq.args[1]) : "";
      const at =
        opts.lastScan && orgId in opts.lastScan ? opts.lastScan[orgId] : NOW.toISOString();
      return { data: at ? [{ scanned_at: at }] : [], error: null };
    }
    return inner(table, ops);
  };
}

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

/**
 * Kho đã nghỉ: đơn cuối trùng với lúc agent im (kho tắt máy sau ca).
 * Đây là ca mà bản khung-giờ phải khai `operating_hours` mới im lặng được.
 */
function closedAt(iso: string, orgId: string = ORG): ScopeOpts {
  return { lastScan: { [orgId]: iso } };
}

/** Chạy một mục kiểm qua runSystemChecks để có luôn lớp bọc safeCheck. */
async function runOne(key: string, resolve: Resolver, now: Date = NOW): Promise<SystemCheck> {
  const { checks } = await runSystemChecks({
    client: fakeDb(resolve) as never,
    now,
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
// 2b. Cron dọn segment mồ côi
//
// Job sinh ra sau sự cố 04/09/2026: một row camera_recording_files có
// ended_at NULL từ 27/08 chặn cắt clip cho 4 đơn ở kho Đại Kim, âm ỉ từ
// 28/07. Nếu chính job dọn nó lại chết âm thầm thì ta lặp đúng kiểu sự cố
// đã sinh ra nó — nên nó phải có mục kiểm riêng, không dựa hơi mục cron
// dọn clip.
// ═══════════════════════════════════════════════════════════════════════

/** Như cronDb nhưng trả dữ liệu KHÁC NHAU cho từng job_name. */
function twoJobDb(
  byJob: Record<string, { lastOk: string | null; latest: { ran_at: string; ok: boolean } | null }>,
): Resolver {
  return (table, ops) => {
    if (table !== "system_jobs") return { data: [], error: null };
    const jobName = Object.keys(byJob).find((name) => hasEq(ops, "job_name", name));
    if (!jobName) return { data: [], error: null };
    const entry = byJob[jobName];
    if (hasEq(ops, "ok", true)) {
      return { data: entry.lastOk ? [{ ran_at: entry.lastOk, ok: true }] : [], error: null };
    }
    return { data: entry.latest ? [entry.latest] : [], error: null };
  };
}

test("cron mồ côi: ca ok — chạy xong 2 giờ trước", async () => {
  const c = await runOne(
    CHECK_KEYS.cronOrphanSegments,
    cronDb(hoursAgo(2), { ran_at: hoursAgo(2), ok: true }),
  );
  assert.equal(c.status, "ok");
  assert.match(c.message, /segment mồ côi/);
});

test("cron mồ côi: ca crit — 60 giờ không chạy xong", async () => {
  const c = await runOne(
    CHECK_KEYS.cronOrphanSegments,
    cronDb(hoursAgo(60), { ran_at: hoursAgo(60), ok: true }),
  );
  assert.equal(c.status, "crit");
  assert.match(c.message, /segment mồ côi/);
});

test("cron mồ côi: chưa từng chạy → crit, chỉ đúng systemd unit của NÓ", async () => {
  const c = await runOne(CHECK_KEYS.cronOrphanSegments, cronDb(null, null));
  assert.equal(c.status, "crit");
  assert.match(
    c.message,
    /betabox-orphan-segments/,
    "phải chỉ đúng timer để người trực SSH vào kiểm, không chỉ nhầm sang betabox-cleanup",
  );
});

test("cron mồ côi: chạy đều nhưng lần cuối LỖI → warn, không xanh giả", async () => {
  const c = await runOne(
    CHECK_KEYS.cronOrphanSegments,
    cronDb(hoursAgo(2), { ran_at: hoursAgo(1), ok: false }),
  );
  assert.equal(c.status, "warn");
  assert.match(c.message, /THẤT BẠI/);
});

test("hai mục cron ĐỘC LẬP: job này chết không kéo job kia đỏ theo", async () => {
  // Vế quan trọng nhất của việc tách mục: nếu hai mục đọc chung một
  // job_name thì job mồ côi chết mà mục vẫn xanh nhờ cron dọn clip ping —
  // đúng cái bẫy "dùng chung UUID healthchecks" đã ghi trong file .service.
  const db = twoJobDb({
    "cleanup-clips": { lastOk: hoursAgo(2), latest: { ran_at: hoursAgo(2), ok: true } },
    "close-orphan-segments": { lastOk: null, latest: null },
  });

  const cleanup = await runOne(CHECK_KEYS.cronCleanup, db);
  const orphan = await runOne(CHECK_KEYS.cronOrphanSegments, db);

  assert.equal(cleanup.status, "ok", "cron dọn clip vẫn chạy tốt");
  assert.equal(orphan.status, "crit", "cron mồ côi chết phải đỏ RIÊNG");
});

test("hai mục cron ĐỘC LẬP: vế ngược lại cũng đúng", async () => {
  const db = twoJobDb({
    "cleanup-clips": { lastOk: null, latest: null },
    "close-orphan-segments": { lastOk: hoursAgo(1), latest: { ran_at: hoursAgo(1), ok: true } },
  });

  const cleanup = await runOne(CHECK_KEYS.cronCleanup, db);
  const orphan = await runOne(CHECK_KEYS.cronOrphanSegments, db);

  assert.equal(cleanup.status, "crit");
  assert.equal(orphan.status, "ok");
});

test("cron mồ côi: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.cronOrphanSegments, BOOM);
  assert.equal(c.status, "unknown");
  assert.match(c.message, /connection reset/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Heartbeat agent
// ═══════════════════════════════════════════════════════════════════════

function agentDb(
  rows: Array<{ code: string; last_seen_at: string | null; organization_id?: string }>,
  scope: ScopeOpts = {},
): Resolver {
  const withOrg = rows.map((r) => ({ organization_id: ORG, ...r }));
  return withScope(
    (table) =>
      table === "warehouse_agents" ? { data: withOrg, error: null } : { data: [], error: null },
    scope,
  );
}

test("agent: ca ok — ping 5 phút trước", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: minutesAgo(5) }]));
  assert.equal(c.status, "ok");
});

test("agent: ca warn — kho vẫn đóng gói 45 phút sau khi agent im", async () => {
  // 45 phút im, đơn cuối lúc NOW → mất 45 − 15 grace = 30 phút bằng chứng.
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: minutesAgo(46) }]));
  assert.equal(c.status, "warn");
  assert.match(c.message, /KHO-A/);
});

test("agent: ca crit — im 19 giờ mà kho vẫn quét đơn, đúng sự cố đã xảy ra", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-A", last_seen_at: hoursAgo(19) }]));
  assert.equal(c.status, "crit");
  assert.match(c.message, /18 giờ/);
});

test("agent: agent mất nhiều bằng chứng nhất quyết định, không bị agent khoẻ che", async () => {
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([
      { code: "KHO-A", last_seen_at: minutesAgo(1) },
      { code: "KHO-B", last_seen_at: hoursAgo(5) },
      { code: "KHO-C", last_seen_at: minutesAgo(2) },
    ]),
  );
  assert.equal(c.status, "crit");
  assert.match(c.message, /KHO-B/);
});

test("agent: chưa từng kết nối mà kho ĐÃ đóng gói đơn → crit", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([{ code: "KHO-MOI", last_seen_at: null }]));
  assert.equal(c.status, "crit");
  assert.match(c.message, /đóng gói/);
});

test("agent: chưa từng kết nối và kho CŨNG chưa đóng gói → unknown, không báo động", async () => {
  // Kho vừa tạo, đang onboard. Đây là việc cài đặt, không phải sự cố.
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "KHO-MOI", last_seen_at: null }], { lastScan: { [ORG]: null } }),
  );
  assert.equal(c.status, "unknown");
  assert.notEqual(c.status, "crit");
});

test("agent: không có agent active → unknown chứ không phải ok", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([]));
  assert.equal(c.status, "unknown");
});

test("agent: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, BOOM);
  assert.equal(c.status, "unknown");
});

// ── Phạm vi production ────────────────────────────────────────────────

test("agent: chỉ hỏi agent thuộc org bật theo dõi (agent demo bị loại)", async () => {
  // Bằng chứng là câu .in(organization_id, …) — fakeDb không tự lọc, nên
  // nếu mục kiểm quên lọc thì test này chết đúng chỗ.
  let captured: unknown[] | null = null;
  const resolve = withScope((table, ops) => {
    if (table !== "warehouse_agents") return { data: [], error: null };
    captured = findIn(ops, "organization_id");
    return {
      data: [{ code: "KHO-A", last_seen_at: minutesAgo(2), organization_id: ORG }],
      error: null,
    };
  });
  const c = await runOne(CHECK_KEYS.agentHeartbeat, resolve);
  assert.equal(c.status, "ok");
  assert.deepEqual(captured, [ORG]);
});

test("agent: không org nào bật theo dõi → unknown, và nói ra là cờ đang tắt", async () => {
  const c = await runOne(CHECK_KEYS.agentHeartbeat, agentDb([], { orgs: [] }));
  assert.equal(c.status, "unknown");
  assert.match(c.message, /monitoring_enabled/);
});

// ── Đối chiếu với hoạt động thật, KHÔNG với đồng hồ ───────────────────
//
// Nhóm ca dưới đây là lý do tồn tại của cả cách đo: cùng một agent im 19
// giờ, kết luận đổi hoàn toàn theo việc kho có TIẾP TỤC ĐÓNG GÓI sau đó
// không. Không ca nào ở đây phụ thuộc giờ hệ thống — đổi `now` không đổi
// kết luận, và đó chính là điều bản khung-giờ không làm được.

/** 17:37 thứ Bảy — mốc cuối trước khi kho nghỉ hai ngày. */
const SAT_1737 = new Date("2026-08-08T10:37:00Z").toISOString();

test("agent: kho ĐÓNG CỬA (đơn cuối trùng lúc agent im) → ok, KHÔNG cảnh báo", async () => {
  // Đây chính là tin Lark 20:00 mỗi tối mà bản đo-tuổi-thô sẽ bắn, và là
  // ca mà bản khung-giờ phải khai operating_hours mới im được.
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "AGENT_KHO_DAI_KIM", last_seen_at: hoursAgo(19) }], closedAt(hoursAgo(19))),
  );
  assert.equal(c.status, "ok");
  assert.match(c.message, /Không kho nào/);
});

test("agent: nghỉ cả cuối tuần rồi mở lại → vẫn ok, tuổi thô 40 giờ không đẻ ra báo động", async () => {
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "AGENT_KHO_DAI_KIM", last_seen_at: SAT_1737 }], closedAt(SAT_1737)),
  );
  assert.equal(c.status, "ok");
});

test("agent: kho mở cửa mà agent chưa lên → warn rồi crit theo lượng đơn đã quét", async () => {
  // Nửa còn lại: bịt báo động giả không được phép bịt luôn báo động thật.
  // Agent vẫn im từ thứ Bảy, nhưng kho ĐÃ quét đơn sáng thứ Hai.
  const warn = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "AGENT_KHO_DAI_KIM", last_seen_at: SAT_1737 }], {
      // Đơn cuối 45 phút sau mốc im → mất 30 phút bằng chứng.
      lastScan: { [ORG]: new Date(new Date(SAT_1737).getTime() + 46 * 60_000).toISOString() },
    }),
  );
  assert.equal(warn.status, "warn");

  const crit = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "AGENT_KHO_DAI_KIM", last_seen_at: SAT_1737 }], {
      // Đơn cuối 3 giờ sau mốc im → mất 2h45 bằng chứng.
      lastScan: { [ORG]: new Date(new Date(SAT_1737).getTime() + 3 * 3_600_000).toISOString() },
    }),
  );
  assert.equal(crit.status, "crit");
  assert.match(crit.message, /Gọi kiểm máy kho/);
});

test("agent: kết luận KHÔNG phụ thuộc giờ hệ thống", async () => {
  // Cùng dữ liệu, ba mốc `now` cách nhau nhiều ngày → cùng một kết luận.
  // Bản khung-giờ sẽ cho ba kết quả khác nhau ở đúng bộ dữ liệu này.
  const db = agentDb(
    [{ code: "KHO-A", last_seen_at: SAT_1737 }],
    { lastScan: { [ORG]: new Date(new Date(SAT_1737).getTime() + 3 * 3_600_000).toISOString() } },
  );
  for (const now of [NOW, new Date("2026-08-10T02:35:00Z"), new Date("2026-08-20T22:00:00Z")]) {
    const c = await runOne(CHECK_KEYS.agentHeartbeat, db, now);
    assert.equal(c.status, "crit", `đổi now (${now.toISOString()}) không được đổi kết luận`);
  }
});

test("agent: kho đã nghỉ không che được kho khác đang mất bằng chứng", async () => {
  const c = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb(
      [
        { code: "KHO-DA-NGHI", last_seen_at: hoursAgo(19), organization_id: "org-2" },
        { code: "KHO-DANG-CHAY", last_seen_at: hoursAgo(3) },
      ],
      {
        orgs: [
          { id: ORG, name: "Kho đang chạy" },
          { id: "org-2", name: "Kho đã nghỉ" },
        ],
        // org-2 nghỉ: đơn cuối trùng mốc im. ORG dùng mặc định = NOW.
        lastScan: { "org-2": hoursAgo(19) },
      },
    ),
  );
  assert.equal(c.status, "crit");
  assert.match(c.message, /KHO-DANG-CHAY/);
  assert.ok(!/KHO-DA-NGHI/.test(c.message), "kho đã nghỉ không được vào tin cảnh báo");
});

test("agent: grace nuốt đơn bấm nốt lúc đóng cửa, KHÔNG nuốt sự cố thật", async () => {
  // Nhân viên bấm nốt một đơn 10 phút sau khi agent tắt → dưới grace 15' → ok.
  const inGrace = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "KHO-A", last_seen_at: hoursAgo(5) }], {
      lastScan: { [ORG]: new Date(new Date(hoursAgo(5)).getTime() + 10 * 60_000).toISOString() },
    }),
  );
  assert.equal(inGrace.status, "ok");

  // 50 phút thì không còn là "bấm nốt" → 35 phút bằng chứng đã mất.
  const beyond = await runOne(
    CHECK_KEYS.agentHeartbeat,
    agentDb([{ code: "KHO-A", last_seen_at: hoursAgo(5) }], {
      lastScan: { [ORG]: new Date(new Date(hoursAgo(5)).getTime() + 50 * 60_000).toISOString() },
    }),
  );
  assert.equal(beyond.status, "warn");
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Camera probe
// ═══════════════════════════════════════════════════════════════════════

interface CamRow {
  camera_code: string;
  last_probe_at: string | null;
  probe_consecutive_fails: number;
  /** Mặc định false — phần lớn ca dưới đây nói về camera đang lỗi. */
  last_probe_ok?: boolean;
  organization_id?: string;
}

function cameraDb(rows: CamRow[], scope: ScopeOpts = {}): Resolver {
  // Mục kiểm không còn lọc `last_probe_ok=false` ở SQL nữa (cần mẫu số để
  // nói "1/13 camera lỗi"), nên hàng giả phải khai đủ cột như bảng thật.
  const full = rows.map((r) => ({ organization_id: ORG, last_probe_ok: false, ...r }));
  return withScope(
    (table) => (table === "cameras" ? { data: full, error: null } : { data: [], error: null }),
    scope,
  );
}

/** Một camera khoẻ — để mẫu số khác 0 ở những ca không nói về camera lỗi. */
const CAM_OK: CamRow = {
  camera_code: "CAM-OK",
  last_probe_ok: true,
  last_probe_at: minutesAgo(1),
  probe_consecutive_fails: 0,
};

test("camera: ca ok — không camera nào lỗi", async () => {
  const c = await runOne(CHECK_KEYS.cameraProbe, cameraDb([CAM_OK]));
  assert.equal(c.status, "ok");
  // Mẫu số phải có mặt: "0 camera lỗi" không nói được là 0/1 hay 0/40.
  assert.match(c.value, /1\/1/);
});

test("camera: không có camera active nào → unknown, không phải ok", async () => {
  // Ô xanh dựa trên bảng rỗng là đúng thứ ràng buộc số 3 của checks.ts cấm.
  const c = await runOne(CHECK_KEYS.cameraProbe, cameraDb([]));
  assert.equal(c.status, "unknown");
  assert.match(c.message, /không có camera|Không có camera/);
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

test("camera: MỘT PHẦN probe cũ → unknown, KHÔNG đỏ vĩnh viễn", async () => {
  // Camera ngừng ghi giữ last_probe_ok=false mãi mãi. Đếm nhóm này là tự
  // tạo ra một ô đỏ không bao giờ tắt, và người trực sẽ học cách phớt lờ.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([
      CAM_OK,
      { camera_code: "CAM-CU", last_probe_at: hoursAgo(30), probe_consecutive_fails: 5000 },
    ]),
  );
  assert.equal(c.status, "unknown");
  assert.match(c.message, /số liệu.*cũ|không được probe/);
});

test("camera: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.cameraProbe, BOOM);
  assert.equal(c.status, "unknown");
});

test("camera: kho nghỉ (MỌI probe đều cũ) → skipped, KHÔNG trả 'ok, 0 camera lỗi'", async () => {
  // Kho nghỉ thì agent ngừng probe, `last_probe_at` tự cũ đi. Im lặng đến
  // từ chính dữ liệu, không từ một khung giờ ai đó khai.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-1", last_probe_at: hoursAgo(19), probe_consecutive_fails: 0 }]),
  );
  assert.equal(c.status, "skipped");
  assert.notEqual(c.status, "ok");
});

test("camera: kho nghỉ vẫn trả DANH SÁCH camera — 'chưa đo' khác 'không tồn tại'", async () => {
  // Ca đã cắn 13/08: bản trước thoát sớm với entities rỗng, nên lúc kho đóng
  // cửa ô đầu trang hiện "0/0 · Chưa khai camera nào" cho kho có camera thật.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-1", last_probe_at: hoursAgo(19), probe_consecutive_fails: 0 }]),
  );
  assert.equal((c.entities ?? []).length, 1);
  assert.equal(c.entities?.[0].status, "skipped");
  assert.match(c.value, /1\/1/);
});

test("camera: probe CŨ mà last_probe_ok=true vẫn KHÔNG được tính là xanh", async () => {
  // Bẫy của bản trước: xét last_probe_ok trước độ tươi, nên ban đêm mọi
  // camera hiện xanh dựa trên một lần probe thành công từ chiều hôm trước.
  const c = await runOne(
    CHECK_KEYS.cameraProbe,
    cameraDb([{ camera_code: "CAM-1", last_probe_ok: true, last_probe_at: hoursAgo(19), probe_consecutive_fails: 0 }]),
  );
  assert.notEqual(c.status, "ok");
  assert.equal(c.entities?.[0].bucket, "stale");
});

test("camera: 0 camera active thì nói 'không có camera', không nấp sau 'kho nghỉ'", async () => {
  const c = await runOne(CHECK_KEYS.cameraProbe, cameraDb([]));
  assert.equal(c.status, "unknown");
  assert.match(c.message, /Không có camera/);
});

test("camera: chỉ hỏi camera của org bật theo dõi", async () => {
  let captured: unknown[] | null = null;
  const resolve = withScope((table, ops) => {
    if (table !== "cameras") return { data: [], error: null };
    captured = findIn(ops, "organization_id");
    return { data: [{ ...CAM_OK, organization_id: ORG }], error: null };
  });
  const c = await runOne(CHECK_KEYS.cameraProbe, resolve);
  assert.equal(c.status, "ok");
  assert.deepEqual(captured, [ORG]);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Ghi hình còn tươi không
// ═══════════════════════════════════════════════════════════════════════

function recordingDb(endedAt: string | null, scope: ScopeOpts = {}): Resolver {
  return withScope(
    (table) =>
      table === "camera_recording_files"
        ? { data: endedAt ? [{ ended_at: endedAt }] : [], error: null }
        : { data: [], error: null },
    scope,
  );
}

test("ghi hình: ca ok — segment gần nhất 2 phút trước", async () => {
  const c = await runOne(CHECK_KEYS.recording, recordingDb(minutesAgo(2)));
  assert.equal(c.status, "ok");
});

test("ghi hình: ca warn — kho đóng gói 15 phút sau segment cuối", async () => {
  const c = await runOne(CHECK_KEYS.recording, recordingDb(minutesAgo(15)));
  assert.equal(c.status, "warn");
});

test("ghi hình: ca crit — 45 phút đóng gói mà không file nào rơi xuống đĩa", async () => {
  const c = await runOne(CHECK_KEYS.recording, recordingDb(minutesAgo(45)));
  assert.equal(c.status, "crit");
  assert.match(c.message, /ffmpeg/);
});

test("ghi hình: chưa có segment mà kho ĐÃ đóng gói → crit", async () => {
  const c = await runOne(CHECK_KEYS.recording, recordingDb(null));
  assert.equal(c.status, "crit");
});

test("ghi hình: chưa có segment và kho CŨNG chưa đóng gói → unknown", async () => {
  const c = await runOne(CHECK_KEYS.recording, recordingDb(null, { lastScan: { [ORG]: null } }));
  assert.equal(c.status, "unknown");
  assert.notEqual(c.status, "crit");
});

test("ghi hình: kho đã nghỉ (đơn cuối trùng segment cuối) → ok, không cảnh báo", async () => {
  // Không có segment lúc 3 giờ sáng là bình thường, không phải sự cố — và
  // hệ biết điều đó vì kho cũng không quét đơn nào sau segment cuối.
  const c = await runOne(CHECK_KEYS.recording, recordingDb(hoursAgo(19), closedAt(hoursAgo(19))));
  assert.equal(c.status, "ok");
  assert.notEqual(c.status, "crit");
});

test("ghi hình: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.recording, BOOM);
  assert.equal(c.status, "unknown");
});

test("ghi hình bắt được ca mà heartbeat + probe cùng xanh", async () => {
  // Đây là lý do tồn tại của mục này: agent còn ping, camera còn trả RTSP,
  // nhưng ffmpeg treo nên không file nào rơi xuống đĩa. Hai mục kia mù ca
  // này hoàn toàn — đúng hình dạng sự cố watchdog runtime của agent v0.7.0.
  const resolve = withScope((table) => {
    if (table === "warehouse_agents") {
      return { data: [{ code: "KHO-A", last_seen_at: minutesAgo(1), organization_id: ORG }], error: null };
    }
    if (table === "cameras") {
      return { data: [{ ...CAM_OK, organization_id: ORG }], error: null };
    }
    if (table === "camera_recording_files") {
      return { data: [{ ended_at: minutesAgo(45) }], error: null };
    }
    return { data: [], error: null };
  });
  const { checks } = await runSystemChecks({
    client: fakeDb(resolve) as never,
    now: NOW,
    os: { totalmem: () => 8 * 1024 ** 3, freemem: () => 4 * 1024 ** 3 },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
  });
  assert.equal(checks.find((c) => c.key === CHECK_KEYS.agentHeartbeat)!.status, "ok");
  assert.equal(checks.find((c) => c.key === CHECK_KEYS.cameraProbe)!.status, "ok");
  assert.equal(checks.find((c) => c.key === CHECK_KEYS.recording)!.status, "crit");
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Clip đơn hàng sinh lỗi
// ═══════════════════════════════════════════════════════════════════════

function clipDb(
  rows: Array<{ organization_id?: string; error_message: string | null }>,
  scope: ScopeOpts = {},
): Resolver {
  const full = rows.map((r) => ({ organization_id: ORG, ...r }));
  return withScope(
    (table) =>
      table === "order_proof_clips" ? { data: full, error: null } : { data: [], error: null },
    scope,
  );
}

test("clip: ca ok — không clip nào lỗi trong 24 giờ", async () => {
  const c = await runOne(CHECK_KEYS.clipFailures, clipDb([]));
  assert.equal(c.status, "ok");
});

test("clip: một clip lỗi → warn, và nêu lý do đầu tiên", async () => {
  const c = await runOne(
    CHECK_KEYS.clipFailures,
    clipDb([{ error_message: "ffmpeg exit 1: moov atom not found" }]),
  );
  assert.equal(c.status, "warn");
  const entity = (c.entities ?? []).find((e) => e.orgId === ORG)!;
  assert.equal(entity.count, 1);
  assert.match(entity.detail, /moov atom not found/);
});

test("clip: từ 5 lỗi trở lên → crit, đọc là hỏng hệ thống chứ không phải ca lẻ", async () => {
  const c = await runOne(
    CHECK_KEYS.clipFailures,
    clipDb(Array.from({ length: 5 }, () => ({ error_message: "encode_timeout" }))),
  );
  assert.equal(c.status, "crit");
  assert.match(c.message, /không phải ca lẻ/);
});

test("clip: KHÔNG phụ thuộc kho đang chạy hay đã nghỉ — đơn hỏng vẫn là đơn hỏng", async () => {
  // Khác hẳn heartbeat/ghi hình: hai mục đó đối chiếu với hoạt động, mục
  // này thì không — clip sinh lỗi lúc 3 giờ sáng vẫn là một đơn hàng không
  // có bằng chứng vào sáng hôm sau.
  const c = await runOne(
    CHECK_KEYS.clipFailures,
    clipDb([{ error_message: "x" }], closedAt(hoursAgo(19))),
  );
  assert.equal(c.status, "warn");
  assert.notEqual(c.status, "skipped");
});

test("clip: org 0 lỗi vẫn có entity, để bảng theo kho không bị ô trống", async () => {
  const c = await runOne(CHECK_KEYS.clipFailures, clipDb([]));
  const entity = (c.entities ?? []).find((e) => e.orgId === ORG);
  assert.ok(entity, "org không lỗi vẫn phải có entity");
  assert.equal(entity.count, 0);
  assert.equal(entity.status, "ok");
});

test("clip: ca nguồn hỏng → unknown, KHÔNG ném", async () => {
  const c = await runOne(CHECK_KEYS.clipFailures, BOOM);
  assert.equal(c.status, "unknown");
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Disk + RAM VPS
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
  const { checks } = await runSystemChecks({
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
// 8-9. Hai mục chưa có nguồn
// ═══════════════════════════════════════════════════════════════════════

test("disk kho: unknown và nói rõ agent chưa gửi dữ liệu này", () => {
  const c = checkWarehouseDisk();
  assert.equal(c.status, "unknown");
  assert.match(c.message, /Chưa có nguồn dữ liệu/);
  assert.match(c.message, /heartbeat/);
});

test("dung lượng Storage: unknown vì thiếu MẪU SỐ, không bịa số tuyệt đối", () => {
  // Bẫy đúng của ô này: tử số đếm được (quét storage.objects) nên rất dễ
  // hiện "1.2 TB" cho đẹp. Nhưng không có hạn mức thì con số đó không trả
  // lời được câu duy nhất cần hỏi — sắp đầy chưa.
  const c = checkStorageUsage();
  assert.equal(c.status, "unknown");
  assert.equal(c.unknownKind, "structural");
  assert.match(c.message, /hạn mức/);
  assert.notEqual(c.status, "ok");
});

// ═══════════════════════════════════════════════════════════════════════
// Toàn loạt
// ═══════════════════════════════════════════════════════════════════════

test("runSystemChecks: luôn trả đủ 10 mục, đúng thứ tự cố định", async () => {
  const { checks, scope } = await runSystemChecks({
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
      CHECK_KEYS.cronOrphanSegments,
      CHECK_KEYS.agentHeartbeat,
      CHECK_KEYS.cameraProbe,
      CHECK_KEYS.recording,
      CHECK_KEYS.clipFailures,
      CHECK_KEYS.vps,
      CHECK_KEYS.storage,
      CHECK_KEYS.warehouseDisk,
    ],
  );
  // Hỏng TOÀN BỘ nguồn dữ liệu vẫn phải trả về đủ mục, không ném.
  assert.ok(checks.every((c) => c.status === "unknown"));
  // Nạp phạm vi hụt cũng không được ném — bảng theo kho rỗng, mục vẫn về.
  assert.equal(scope, null);
});

test("runSystemChecks: thiếu env Supabase → unknown, không ném", async () => {
  const { checks } = await runSystemChecks({
    client: undefined,
    now: NOW,
    os: { totalmem: () => 8, freemem: () => 4 },
    statfs: async () => ({ bsize: 4096, blocks: 10, bavail: 5 }),
  });
  const cron = checks.find((c) => c.key === CHECK_KEYS.cronCleanup)!;
  assert.equal(cron.status, "unknown");
  assert.match(cron.message, /Supabase/);
});

test("worstStatus: crit > warn > unknown > ok > skipped", () => {
  const mk = (status: SystemCheck["status"]): SystemCheck => ({ key: "k", status, value: "", message: "" });
  assert.equal(worstStatus([mk("ok"), mk("warn"), mk("crit")]), "crit");
  assert.equal(worstStatus([mk("ok"), mk("warn"), mk("unknown")]), "warn");
  assert.equal(worstStatus([mk("ok"), mk("unknown")]), "unknown");
  assert.equal(worstStatus([mk("ok"), mk("ok")]), "ok");
  // skipped KHÔNG được kéo mức tổng xuống, và cũng không được tự nhận là ok.
  assert.equal(worstStatus([mk("ok"), mk("skipped")]), "ok");
  assert.equal(worstStatus([mk("skipped"), mk("skipped")]), "skipped");
  assert.equal(worstStatus([mk("skipped"), mk("crit")]), "crit");
});

test("skipped KHÔNG BAO GIỜ thành cảnh báo — cửa cuối trước khi gửi Lark", () => {
  const mk = (status: SystemCheck["status"]): SystemCheck => ({ key: "k", status, value: "", message: "" });
  assert.deepEqual(needsAlert([mk("skipped"), mk("ok")]), []);
  assert.deepEqual(incidentUnknowns([mk("skipped")]), []);
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
