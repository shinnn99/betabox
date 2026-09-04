import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_BUCKET,
  CHECK_KEYS,
  runSystemChecks,
  type MonitoringScope,
  type SystemCheck,
} from "../src/lib/system/checks.ts";
import {
  buildHeroStats,
  buildInfraTiles,
  buildIssues,
  buildOrgHealth,
  sharedChecks,
  unavailableChecks,
} from "../src/lib/system/status-view.ts";

/**
 * Tầng hiển thị: biến 6 mục kiểm thành "hỏng cái gì, ở kho nào, làm gì".
 *
 * Ca trung tâm của cả file này là ca NHIỀU KHO. Bản đầu gộp mọi agent về
 * một dòng tệ nhất và nối mọi mã camera vào một chuỗi — với một kho thì
 * không lộ, ba kho cùng chết thì chỉ hiện một cái tên và sửa xong kho đó ô
 * vẫn đỏ mà không ai biết vì sao. Mọi test dưới đây phải chết nếu ai đó
 * quay lại cách gộp cũ.
 */

const NOW = new Date("2026-08-12T10:00:00Z");

function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}
function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

// ── Supabase client giả (cùng khuôn với system-checks.test.ts) ─────────

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

/** Ba tổ chức, cả ba theo dõi 24/7 để ca này chỉ nói về chuyện nhiều kho. */
const ORGS = [
  { id: "org-a", name: "Kho Đại Kim" },
  { id: "org-b", name: "Kho Cầu Giấy" },
  { id: "org-c", name: "Kho Long Biên" },
];

interface World {
  agents?: Array<{ id: string; code: string; last_seen_at: string | null; organization_id: string }>;
  cameras?: Array<{
    id: string;
    camera_code: string;
    organization_id: string;
    last_probe_ok: boolean;
    last_probe_at: string | null;
    probe_consecutive_fails: number;
  }>;
  orgs?: Array<{ id: string; name: string }>;
  warehouses?: Array<{ organization_id: string; name: string }>;
  /** Mốc segment gần nhất, theo org. Thiếu key = kho chưa ghi gì. */
  recordingEndedAt?: Record<string, string>;
  /**
   * Mốc đơn cuối, theo org. Thiếu key = mặc định NOW ("kho đang làm việc"),
   * để các ca không nói về hoạt động giữ nguyên ý nghĩa cũ.
   */
  lastScan?: Record<string, string | null>;
  clipFailures?: Array<{ organization_id: string; error_message: string | null }>;
}

/** Tìm lại org của một truy vấn per-org qua chính câu .eq() của nó. */
function eqOrg(ops: Op[]): string {
  const eq = ops.find((o) => o.method === "eq" && o.args[0] === "organization_id");
  return eq ? String(eq.args[1]) : "";
}

function world(w: World): Resolver {
  return (table, ops) => {
    if (table === "organizations") return { data: w.orgs ?? ORGS, error: null };
    if (table === "warehouses") return { data: w.warehouses ?? [], error: null };
    if (table === "warehouse_agents") return { data: w.agents ?? [], error: null };
    if (table === "cameras") return { data: w.cameras ?? [], error: null };
    if (table === "packing_events") {
      const orgId = eqOrg(ops);
      const at = w.lastScan && orgId in w.lastScan ? w.lastScan[orgId] : NOW.toISOString();
      return { data: at ? [{ scanned_at: at }] : [], error: null };
    }
    if (table === "camera_recording_files") {
      const orgId = eqOrg(ops);
      // Mặc định: vừa ghi xong, để các ca không nói về ghi hình đều xanh.
      const endedAt = w.recordingEndedAt ? w.recordingEndedAt[orgId] : minutesAgo(1);
      return { data: endedAt ? [{ ended_at: endedAt }] : [], error: null };
    }
    if (table === "order_proof_clips") return { data: w.clipFailures ?? [], error: null };
    if (table === "system_jobs") {
      // Cron xanh: không để mục cron chen vào danh sách sự cố của các ca dưới.
      if (hasEq(ops, "ok", true)) return { data: [{ ran_at: hoursAgo(2), ok: true }], error: null };
      return { data: [{ ran_at: hoursAgo(2), ok: true }], error: null };
    }
    return { data: [], error: null };
  };
}

async function snapshot(w: World): Promise<{ checks: SystemCheck[]; scope: MonitoringScope | null }> {
  return runSystemChecks({
    client: fakeDb(world(w)) as never,
    now: NOW,
    os: { totalmem: () => 8 * 1024 ** 3, freemem: () => 4 * 1024 ** 3 },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
  });
}

const agent = (code: string, orgId: string, lastSeen: string | null) => ({
  id: `id-${code}`,
  code,
  organization_id: orgId,
  last_seen_at: lastSeen,
});

const cam = (
  code: string,
  orgId: string,
  opts: { ok?: boolean; probeAt?: string | null; fails?: number } = {},
) => ({
  id: `id-${code}`,
  camera_code: code,
  organization_id: orgId,
  last_probe_ok: opts.ok ?? true,
  last_probe_at: opts.probeAt ?? minutesAgo(1),
  probe_consecutive_fails: opts.fails ?? 0,
});

// ═══════════════════════════════════════════════════════════════════════
// Ca trung tâm: nhiều kho cùng hỏng
// ═══════════════════════════════════════════════════════════════════════

test("nhiều kho chết cùng lúc → MỖI kho một dòng sự cố, không gộp về một", async () => {
  const { checks, scope } = await snapshot({
    agents: [
      agent("AGENT_A", "org-a", hoursAgo(5)), // crit
      agent("AGENT_B", "org-b", hoursAgo(1)), // warn
      agent("AGENT_C", "org-c", minutesAgo(2)), // ok
    ],
  });

  // Mục kiểm gộp vẫn nói đúng một câu — đó là thứ đi vào tin Lark, không đổi.
  const check = checks.find((c) => c.key === CHECK_KEYS.agentHeartbeat)!;
  assert.equal(check.status, "crit");

  // Còn trang thì phải kể ĐỦ. Đây là chỗ bản đầu mất thông tin: AGENT_B
  // biến mất hoàn toàn khỏi màn hình vì AGENT_A tệ hơn.
  const issues = buildIssues(checks, scope);
  const agentIssues = issues.filter((i) => i.checkKey === CHECK_KEYS.agentHeartbeat);
  assert.equal(agentIssues.length, 2);
  assert.deepEqual(
    agentIssues.map((i) => i.what).sort(),
    ["AGENT_A", "AGENT_B"],
  );
  // Agent khoẻ KHÔNG được lọt vào danh sách việc phải làm.
  assert.ok(!agentIssues.some((i) => i.what === "AGENT_C"));
});

test("sự cố nói rõ Ở ĐÂU và LÀM GÌ, có đường đi tiếp", async () => {
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", hoursAgo(5))],
  });
  const issue = buildIssues(checks, scope).find((i) => i.what === "AGENT_A")!;

  assert.equal(issue.where, "Kho Đại Kim"); // tên org, không phải UUID
  assert.equal(issue.status, "crit");
  assert.match(issue.symptom, /đóng gói 4 giờ 45 phút sau khi agent im/);
  assert.match(issue.action, /gọi kiểm máy/i);
  assert.equal(issue.href, "/platform/orgs/org-a");
});

test("sự cố xếp nặng trước: crit → warn → chưa rõ", async () => {
  const { checks, scope } = await snapshot({
    agents: [
      agent("AGENT_B", "org-b", hoursAgo(1)), // warn
      agent("AGENT_A", "org-a", hoursAgo(5)), // crit
    ],
    cameras: [cam("CAM-OK", "org-c")],
    // org-c chưa đóng gói đơn nào → agent của nó không có mốc đối chiếu →
    // "chưa rõ". Đó là nguồn `unknown` duy nhất còn lại sau khi camera
    // probe-cũ chuyển sang "skipped".
    lastScan: { "org-c": null },
  });
  const issues = buildIssues(checks, scope);
  assert.deepEqual(
    issues.map((i) => i.status),
    ["crit", "warn", "unknown"],
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Camera: mẫu số và ngưỡng
// ═══════════════════════════════════════════════════════════════════════

test("camera lỗi dưới ngưỡng KHÔNG thành việc phải làm, nhưng vẫn có trong bảng kho", async () => {
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", minutesAgo(2))],
    // 10 nhịp × 30s = 5 phút, dưới ngưỡng 2 giờ.
    cameras: [cam("CAM-1", "org-a", { ok: false, fails: 10 }), cam("CAM-2", "org-a")],
  });

  const issues = buildIssues(checks, scope).filter((i) => i.checkKey === CHECK_KEYS.cameraProbe);
  assert.equal(issues.length, 0);

  const orgA = buildOrgHealth(checks, scope).find((o) => o.orgId === "org-a")!;
  assert.equal(orgA.cameras.total, 2);
  assert.equal(orgA.cameras.failingShort, 1);
  assert.equal(orgA.cameras.failingLong, 0);
});

test("camera lỗi kéo dài của KHO NÀO thì hiện đúng kho đó", async () => {
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", minutesAgo(2)), agent("AGENT_B", "org-b", minutesAgo(2))],
    cameras: [
      cam("CAM-A1", "org-a"),
      cam("CAM-B1", "org-b", { ok: false, fails: 300 }), // 2.5 giờ
      cam("CAM-B2", "org-b", { ok: false, fails: 300 }),
    ],
  });

  const issues = buildIssues(checks, scope).filter((i) => i.checkKey === CHECK_KEYS.cameraProbe);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.where === "Kho Cầu Giấy"));
  assert.ok(issues.every((i) => i.href === "/platform/orgs/org-b"));

  const orgs = buildOrgHealth(checks, scope);
  assert.equal(orgs.find((o) => o.orgId === "org-a")!.cameras.failingLong, 0);
  assert.equal(orgs.find((o) => o.orgId === "org-b")!.cameras.failingLong, 2);
});

test("entity camera mang đủ nhóm phân loại để đếm được mẫu số", async () => {
  const { checks } = await snapshot({
    cameras: [
      cam("CAM-1", "org-a"),
      cam("CAM-2", "org-a", { ok: false, fails: 300 }),
      cam("CAM-3", "org-a", { ok: false, probeAt: hoursAgo(30), fails: 900 }),
    ],
  });
  const entities = checks.find((c) => c.key === CHECK_KEYS.cameraProbe)!.entities ?? [];
  assert.equal(entities.length, 3);
  assert.deepEqual(
    entities.map((e) => e.bucket).sort(),
    [CAMERA_BUCKET.failingLong, CAMERA_BUCKET.ok, CAMERA_BUCKET.stale].sort(),
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Bảng theo kho
// ═══════════════════════════════════════════════════════════════════════

test("bảng theo kho có ĐỦ org đang theo dõi, kể cả org không sự cố", async () => {
  const { checks, scope } = await snapshot({
    agents: [
      agent("AGENT_A", "org-a", hoursAgo(5)),
      agent("AGENT_C", "org-c", minutesAgo(2)),
    ],
  });
  const orgs = buildOrgHealth(checks, scope);
  assert.deepEqual(orgs.map((o) => o.orgId), ["org-a", "org-b", "org-c"]);
  assert.equal(orgs.find((o) => o.orgId === "org-a")!.status, "crit");
  assert.equal(orgs.find((o) => o.orgId === "org-c")!.status, "ok");
});

test("org chưa cài agent nào → 'chưa rõ', KHÔNG bị ô '0 clip lỗi' kéo thành xanh", async () => {
  // Bẫy thật: checkClipFailures sinh entity "0 clip lỗi / ok" cho MỌI org
  // đang theo dõi. Không chặn thì một org vừa tạo — chưa agent, chưa camera
  // — sẽ hiện "Bình thường" nhờ đúng cái ô trống đó.
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", minutesAgo(2))],
    // org-b, org-c chưa ghi gì; org-a vẫn ghi bình thường.
    recordingEndedAt: { "org-a": minutesAgo(1) },
  });
  const orgB = buildOrgHealth(checks, scope).find((o) => o.orgId === "org-b")!;
  assert.equal(orgB.agents.length, 0);
  assert.equal(orgB.cameras.total, 0);
  assert.equal(orgB.clipFailures?.status, "ok", "entity clip vẫn là ok — bẫy nằm ở đây");
  assert.notEqual(orgB.status, "ok");
});

test("bảng theo kho rỗng khi không nạp được phạm vi, không ném", () => {
  assert.deepEqual(buildOrgHealth([], null), []);
  assert.deepEqual(buildIssues([], null), []);
});

// ═══════════════════════════════════════════════════════════════════════
// Tầng 4: hạ tầng chung và phần chưa canh được
// ═══════════════════════════════════════════════════════════════════════

test("egress và ổ máy kho xuống chân trang, KHÔNG thành việc phải làm", async () => {
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", minutesAgo(2))],
    cameras: [cam("CAM-1", "org-a")],
  });

  const unavailable = unavailableChecks(checks);
  assert.deepEqual(
    unavailable.map((c) => c.key).sort(),
    [CHECK_KEYS.egress, CHECK_KEYS.storage, CHECK_KEYS.warehouseDisk].sort(),
  );
  // Ba mục này vĩnh viễn unknown; để chúng trong danh sách sự cố là dạy
  // người trực phớt lờ danh sách đó.
  const issues = buildIssues(checks, scope);
  assert.ok(!issues.some((i) => i.checkKey === CHECK_KEYS.egress));
  assert.ok(!issues.some((i) => i.checkKey === CHECK_KEYS.storage));
  assert.ok(!issues.some((i) => i.checkKey === CHECK_KEYS.warehouseDisk));
});

test("nửa còn lại: 'không org nào bật theo dõi' VẪN lên danh sách sự cố", async () => {
  // Bản đầu để ca này rơi vào ô xám chung với egress — cùng một màu với
  // "hạn chế đã biết", nên không ai nhìn. Nó là dấu hiệu cờ bị tắt nhầm.
  const { checks, scope } = await snapshot({ orgs: [] });
  const issues = buildIssues(checks, scope);
  const agentIssue = issues.find((i) => i.checkKey === CHECK_KEYS.agentHeartbeat);
  assert.ok(agentIssue, "mục agent phải có mặt trong danh sách");
  assert.equal(agentIssue.status, "unknown");
  assert.match(agentIssue.symptom, /monitoring_enabled/);
  assert.match(agentIssue.action, /monitoring_enabled/);
});

test("hạ tầng chung đúng hai mục không gắn kho", async () => {
  const { checks } = await snapshot({ agents: [agent("AGENT_A", "org-a", minutesAgo(2))] });
  assert.deepEqual(
    sharedChecks(checks).map((c) => c.key),
    [CHECK_KEYS.cronCleanup, CHECK_KEYS.vps],
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Dãy ô hạ tầng — KHÔNG có uptime bịa
// ═══════════════════════════════════════════════════════════════════════

test("dãy hạ tầng không có ô uptime %, thay bằng thứ đo được thật", async () => {
  const { checks } = await snapshot({ agents: [agent("AGENT_A", "org-a", minutesAgo(2))] });
  const tiles = buildInfraTiles(checks, {
    selfCheckRuns24h: 94,
    selfCheckExpected24h: 96,
    supabaseLatencyMs: 42,
  });
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["self_check", "supabase", CHECK_KEYS.cronCleanup, CHECK_KEYS.vps],
  );
  // Hệ không ghi lịch sử uptime ở đâu cả, nên mọi con số % kiểu "99.98%"
  // chỉ có thể là số bịa. Đây là cửa chặn nó quay lại.
  assert.ok(!tiles.some((t) => /uptime/i.test(t.label) || /9\d\.\d+%/.test(t.value)));
  assert.equal(tiles[0].value, "94/96 lượt");
  assert.equal(tiles[0].status, "ok");
  assert.equal(tiles[1].value, "42 ms");
});

test("tự kiểm nền 0 lượt → crit; đọc hụt sổ → chưa rõ, KHÔNG hiện thành 0", async () => {
  const { checks } = await snapshot({});
  const dead = buildInfraTiles(checks, {
    selfCheckRuns24h: 0,
    selfCheckExpected24h: 96,
    supabaseLatencyMs: 10,
  });
  assert.equal(dead[0].status, "crit");
  assert.match(dead[0].detail, /systemd timer đã chết/);

  // Nửa còn lại: 0 nghĩa là timer chết, còn null nghĩa là không đọc được sổ.
  // Gộp hai ca này lại là biến một lỗi đọc thành một báo động giả.
  const blind = buildInfraTiles(checks, {
    selfCheckRuns24h: null,
    selfCheckExpected24h: 96,
    supabaseLatencyMs: null,
  });
  assert.equal(blind[0].status, "unknown");
  assert.equal(blind[1].status, "unknown");
});

// ═══════════════════════════════════════════════════════════════════════
// Sáu ô số đầu trang
// ═══════════════════════════════════════════════════════════════════════

test("ô số đếm từ dữ liệu thật, không có hằng số minh hoạ", async () => {
  const { checks, scope } = await snapshot({
    orgs: [ORGS[0], ORGS[1]],
    warehouses: [
      { organization_id: "org-a", name: "Kho Đại Kim" },
      { organization_id: "org-b", name: "Kho Cầu Giấy" },
    ],
    agents: [
      agent("AGENT_A", "org-a", minutesAgo(2)), // ok
      agent("AGENT_B", "org-b", hoursAgo(5)), // crit
    ],
    cameras: [
      cam("CAM-A1", "org-a"),
      cam("CAM-A2", "org-a"),
      cam("CAM-B1", "org-b", { ok: false, fails: 300 }), // lỗi kéo dài
    ],
  });
  const issues = buildIssues(checks, scope);
  const hero = buildHeroStats(checks, scope, issues);
  const by = (k: string) => hero.find((h) => h.key === k)!;

  assert.equal(by("warehouses").total, 2);
  assert.equal(by("warehouses").value, 1); // org-b có sự cố → kho của nó không tính
  assert.equal(by("agents").value, 1);
  assert.equal(by("agents").total, 2);
  assert.equal(by("cameras").value, 2);
  assert.equal(by("cameras").total, 3);
  assert.equal(by("incidents").value, issues.filter((i) => i.status === "crit").length);
  assert.equal(by("warnings").value, issues.filter((i) => i.status === "warn").length);
  assert.equal(by("blindspots").value, unavailableChecks(checks).length);
});

test("ô 'Điểm mù' đếm đúng ba mục chưa có nguồn, và không bao giờ tô xanh khi > 0", async () => {
  const { checks, scope } = await snapshot({ agents: [agent("AGENT_A", "org-a", minutesAgo(2))] });
  assert.deepEqual(
    unavailableChecks(checks).map((c) => c.key).sort(),
    [CHECK_KEYS.egress, CHECK_KEYS.storage, CHECK_KEYS.warehouseDisk].sort(),
  );
  const blind = buildHeroStats(checks, scope, buildIssues(checks, scope)).find(
    (h) => h.key === "blindspots",
  )!;
  assert.equal(blind.value, 3);
  assert.notEqual(blind.tone, "ok");
});

// ── Kho đã nghỉ: im lặng phải đến từ DỮ LIỆU, không từ khung giờ ───────

/**
 * Kho đóng cửa 3 giờ trước: agent tắt, segment dừng, VÀ đơn cuối cũng dừng
 * cùng lúc. Ba mốc trùng nhau chính là chữ ký của "nghỉ bình thường" —
 * không cần khai `operating_hours`, không cần biết mấy giờ.
 */
const CLOSED_WORLD: World = {
  orgs: [ORGS[0]],
  warehouses: [{ organization_id: "org-a", name: "Kho Đại Kim" }],
  agents: [agent("AGENT_A", "org-a", hoursAgo(3))],
  // Camera ngừng được probe từ lúc đó → nhóm "stale".
  cameras: [cam("CAM-A1", "org-a", { probeAt: hoursAgo(3) })],
  recordingEndedAt: { "org-a": hoursAgo(3) },
  lastScan: { "org-a": hoursAgo(3) },
};

test("kho đã nghỉ: KHÔNG sinh sự cố nào, dù agent im 3 giờ", async () => {
  // Đây là tin Lark mỗi tối mà bản đo-tuổi-thô sẽ bắn, và là ca mà bản
  // khung-giờ phải khai operating_hours mới im được.
  const { checks, scope } = await snapshot(CLOSED_WORLD);
  assert.deepEqual(buildIssues(checks, scope), []);
});

test("kho đã nghỉ: ô số nói đúng bản chất — máy tắt thật, nhưng không mất gì", async () => {
  // Bản khung-giờ hiện "Agent online 0/1 · 0%" MÀU XANH và "Camera 0/0 ·
  // Chưa khai camera nào". Con số 0 của agent là đúng (máy tắt thật), nhưng
  // màu xanh và chữ "chưa khai camera" đều sai.
  const { checks, scope } = await snapshot(CLOSED_WORLD);
  const hero = buildHeroStats(checks, scope, buildIssues(checks, scope));
  const by = (k: string) => hero.find((h) => h.key === k)!;

  assert.equal(by("agents").value, 0, "máy kho đúng là đang tắt");
  assert.equal(by("agents").total, 1, "vẫn phải biết kho có 1 agent");
  assert.equal(by("agents").tone, "ok", "tắt mà không mất bằng chứng thì không được đỏ");
  assert.match(by("agents").hint, /không đơn nào|Máy kho đang tắt/i);

  assert.equal(by("cameras").value, 0);
  assert.equal(by("cameras").total, 1, "camera vẫn tồn tại dù kho nghỉ");
  assert.ok(!/chưa khai/i.test(by("cameras").hint), "'chưa đo' không được đọc thành 'không có'");
});

test("kho đã nghỉ: bảng vẫn đủ dòng, và chip không phải 'Bình thường'", async () => {
  // checkClipFailures cố ý không đối chiếu hoạt động nên luôn góp entity
  // "ok" — nếu không có gì khác kéo lên thì cả hàng sẽ xanh lúc 3 giờ sáng.
  const { checks, scope } = await snapshot(CLOSED_WORLD);
  const org = buildOrgHealth(checks, scope).find((o) => o.orgId === "org-a")!;
  assert.equal(org.cameras.total, 1, "bảng mất camera mỗi khi kho nghỉ là bug");
  assert.equal(org.cameras.stale, 1);
  assert.equal(org.lastScanAt, hoursAgo(3), "cột 'Đơn cuối' là mốc để đọc mọi ô còn lại");
  assert.equal(org.clipFailures?.status, "ok");
  // "Bình thường" ở đây là XANH THẬT, khác hẳn bản khung-giờ: hệ đã đối
  // chiếu hai mốc có thật (đơn cuối vs heartbeat cuối) và kết luận không
  // mất bằng chứng nào. Không phải xanh vì không kiểm gì.
  assert.equal(org.status, "ok");
});

test("nửa âm: kho đã nghỉ không che được sự cố thật của kho đang chạy", async () => {
  // Bịt báo động giả không được phép bịt luôn báo động thật.
  const { checks, scope } = await snapshot({
    orgs: [ORGS[0], ORGS[1]],
    warehouses: [{ organization_id: "org-a", name: "Kho Đại Kim" }],
    agents: [
      agent("AGENT_A", "org-a", hoursAgo(3)), // nghỉ cùng lúc đơn cuối
      agent("AGENT_B", "org-b", hoursAgo(5)), // chết giữa lúc đang chạy
    ],
    cameras: [
      cam("CAM-A1", "org-a", { probeAt: hoursAgo(3) }),
      cam("CAM-B1", "org-b", { ok: false, fails: 300 }),
    ],
    recordingEndedAt: { "org-a": hoursAgo(3), "org-b": minutesAgo(1) },
    // org-a nghỉ; org-b dùng mặc định NOW = vẫn đang quét đơn.
    lastScan: { "org-a": hoursAgo(3) },
  });
  const issues = buildIssues(checks, scope);
  assert.ok(issues.some((i) => i.what === "AGENT_B" && i.status === "crit"));
  assert.ok(issues.some((i) => i.what === "CAM-B1"));
  assert.ok(!issues.some((i) => i.where === "Kho Đại Kim"), "kho đã nghỉ không được sinh sự cố");

  // Camera của kho nghỉ nằm ở nhóm stale nên không tính là đang hoạt động,
  // nhưng vẫn có trong mẫu số.
  const cameras = buildHeroStats(checks, scope, issues).find((h) => h.key === "cameras")!;
  assert.equal(cameras.total, 2);
  assert.equal(cameras.value, 0);
});

test("đổi giờ hệ thống KHÔNG đổi kết luận của cả trang", async () => {
  // Tính chất trung tâm của cách đo mới. Bản khung-giờ cho ba kết quả khác
  // nhau ở đúng bộ dữ liệu này.
  //
  // Chỉ xét ba mục bám kho. Cron và VPS vẫn phụ thuộc đồng hồ một cách
  // chính đáng — "cron chưa chạy 3 ngày" đúng là tệ dần theo thời gian.
  const KHO_KEYS: string[] = [
    CHECK_KEYS.agentHeartbeat,
    CHECK_KEYS.cameraProbe,
    CHECK_KEYS.recording,
  ];
  const results = [];
  for (const now of [NOW, new Date("2026-08-13T02:00:00Z"), new Date("2026-08-16T21:00:00Z")]) {
    const snap = await runSystemChecks({
      client: fakeDb(world(CLOSED_WORLD)) as never,
      now,
      os: { totalmem: () => 8 * 1024 ** 3, freemem: () => 4 * 1024 ** 3 },
      statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
    });
    results.push(
      buildIssues(snap.checks, snap.scope).filter((i) => KHO_KEYS.includes(i.checkKey)).length,
    );
  }
  assert.deepEqual(results, [0, 0, 0]);
});

test("phạm vi rỗng: ô số không ném, mọi mẫu số về 0", async () => {
  const { checks, scope } = await snapshot({ orgs: [] });
  const hero = buildHeroStats(checks, scope, buildIssues(checks, scope));
  assert.equal(hero.length, 6);
  assert.equal(hero.find((h) => h.key === "warehouses")!.total, 0);
  assert.equal(hero.find((h) => h.key === "agents")!.total, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// Hai cột mới trong bảng kho
// ═══════════════════════════════════════════════════════════════════════

test("bảng kho có cột ghi hình và clip lỗi, gắn đúng kho", async () => {
  const { checks, scope } = await snapshot({
    agents: [agent("AGENT_A", "org-a", minutesAgo(2)), agent("AGENT_B", "org-b", minutesAgo(2))],
    recordingEndedAt: {
      "org-a": minutesAgo(1),
      "org-b": minutesAgo(45), // crit
      "org-c": minutesAgo(1),
    },
    clipFailures: [
      { organization_id: "org-c", error_message: "encode_timeout" },
      { organization_id: "org-c", error_message: "encode_timeout" },
    ],
  });
  const orgs = buildOrgHealth(checks, scope);
  const a = orgs.find((o) => o.orgId === "org-a")!;
  const b = orgs.find((o) => o.orgId === "org-b")!;
  const c = orgs.find((o) => o.orgId === "org-c")!;

  assert.equal(a.recording?.status, "ok");
  assert.equal(b.recording?.status, "crit");
  assert.match(b.recording?.detail ?? "", /45 phút/);

  assert.equal(a.clipFailures?.count, 0);
  assert.equal(c.clipFailures?.count, 2);
  assert.equal(c.clipFailures?.status, "warn");
  // Clip lỗi của org-c KHÔNG được kéo org-a xuống.
  assert.equal(a.clipFailures?.status, "ok");
});

test("VPS đỏ vẫn thành một dòng sự cố kèm việc cần làm", async () => {
  const { checks, scope } = await runSystemChecks({
    client: fakeDb(world({ agents: [agent("AGENT_A", "org-a", minutesAgo(2))] })) as never,
    now: NOW,
    os: { totalmem: () => 100, freemem: () => 90 },
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 0 }), // 100% dùng
  });
  const issue = buildIssues(checks, scope).find((i) => i.checkKey === CHECK_KEYS.vps)!;
  assert.equal(issue.status, "crit");
  assert.equal(issue.where, "Betacom · VPS");
  assert.match(issue.action, /SSH/);
  assert.equal(issue.href, null);
});
