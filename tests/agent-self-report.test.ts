import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_REMOTE_TUNING,
  CAPABILITY,
  LATEST_AGENT_VERSION,
  compareVersions,
  diskDaysLeft,
  hasCapability,
  parseSelfReport,
} from "@/lib/warehouse/self-report";
import { CHECK_CONFIG, checkAgentFleet, diskEntity, fleetEntity, type FleetAgentRow, type MonitoringScope } from "@/lib/system/checks";
import { buildFleetViewRow, returnClipSecondsByOrg, type FleetRow } from "@/lib/warehouse/fleet";
import { returnClipCapSeconds } from "@/lib/order-proof/clip-resolver";
import { MAX_RETURN_CLIP_DURATION_SECONDS } from "@/lib/order-proof/clip-window";
import { resolveWarehouseParams } from "@/lib/config/effective";

/**
 * Đợt 7 — kế hoạch VAN-HANH-NHIEU-KHO, phía cloud: đọc bản tự khai, phán xét
 * (ổ đĩa, bản cũ, hàng đợi), mở trần kiện hoàn THEO KHẢ NĂNG agent.
 */

const NOW = new Date("2026-09-26T09:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const GB = 1024 ** 3;

const report = (p: Record<string, unknown> = {}) => ({
  version: LATEST_AGENT_VERSION,
  cameras: [],
  queues: {},
  capabilities: [CAPABILITY.adaptiveClipBitrate, CAPABILITY.diagnostics],
  ...p,
});

const row = (p: Partial<FleetAgentRow> = {}): FleetAgentRow => ({
  id: "ag-1",
  code: "AGENT_KHO_HN_01",
  organization_id: "org-a",
  last_seen_at: minutesAgo(1),
  self_report: report(),
  self_report_at: minutesAgo(1),
  agent_version: LATEST_AGENT_VERSION,
  ...p,
});

// ── Hai phía phải khớp tên ─────────────────────────────────────────────

test("khả năng agent khai = đúng tên cloud đọc", () => {
  const agent = readFileSync("warehouse-agent/src/self-report.ts", "utf8");
  const m = agent.match(/export const CAPABILITIES = \[([^\]]+)\] as const;/);
  assert.ok(m);
  const agentCaps = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(agentCaps, Object.values(CAPABILITY).sort());
});

test("núm chỉnh cloud gửi = đúng tên agent nhận, trong khoảng agent chấp nhận", () => {
  const agent = readFileSync("warehouse-agent/src/runtime-tuning.ts", "utf8");
  for (const [key, seconds] of Object.entries(AGENT_REMOTE_TUNING)) {
    assert.ok(agent.includes(`src.${key}`), `agent không đọc ${key}`);
    assert.ok(seconds >= 10 && seconds <= 3600, `${key}=${seconds} ngoài khoảng agent nhận`);
  }
  const hb = readFileSync("src/app/api/warehouse/heartbeat/route.ts", "utf8");
  assert.ok(hb.includes("agent_config: AGENT_REMOTE_TUNING,"));
});

test("phiên bản mới nhất phía cloud = phiên bản agent trong kho mã", () => {
  const v = readFileSync("warehouse-agent/src/version.ts", "utf8").match(/AGENT_VERSION = "([^"]+)"/)?.[1];
  assert.equal(v, LATEST_AGENT_VERSION);
});

// ── Bóc bản tự khai phòng thủ ──────────────────────────────────────────

test("không có phiên bản → bỏ cả bản khai", () => {
  assert.equal(parseSelfReport({ cameras: [] }), null);
  assert.equal(parseSelfReport({ version: "abc" }), null);
  assert.equal(parseSelfReport(null), null);
  assert.equal(parseSelfReport([1, 2]), null);
});

test("bóc: bỏ trường lạ, kẹp số âm, chuẩn hoá giờ, giới hạn mảng", () => {
  const r = parseSelfReport({
    version: "0.13.0",
    evil: "x".repeat(10_000),
    uptime_s: -5,
    cameras: [
      ...Array.from({ length: 100 }, (_, i) => ({ code: `c${i}`, recording: true })),
    ],
    disk: {
      free_bytes: 5 * GB,
      total_bytes: 2 * GB,
      bytes_per_day: -1,
      recording_bytes: 3 * GB,
    },
    queues: { scans_pending: 3, clips_pending: "many" },
    last_qr_success_at: "2026-09-26T08:00:00+07:00",
    capabilities: ["adaptive_clip_bitrate", 7, "adaptive_clip_bitrate"],
  })!;
  assert.ok(!("evil" in r));
  assert.equal(r.uptime_s, null);
  assert.equal(r.cameras.length, 64);
  assert.equal(r.disk!.free_bytes, 2 * GB, "trống không được vượt tổng");
  assert.equal(r.disk!.bytes_per_day, null);
  assert.equal(r.disk!.recording_bytes, 2 * GB, "thư mục video không được vượt tổng ổ");
  assert.deepEqual(r.queues, { scans_pending: 3, clips_pending: null, uploads_pending: null });
  assert.equal(r.last_qr_success_at, "2026-09-26T01:00:00.000Z");
  assert.deepEqual(r.capabilities, ["adaptive_clip_bitrate"]);
});

test("so phiên bản và số ngày ổ còn", () => {
  assert.ok(compareVersions("0.12.1", "0.13.0") < 0);
  assert.ok(compareVersions("0.13.0", "0.13.0") === 0);
  assert.ok(compareVersions("1.0.0", "0.13.9") > 0);
  assert.equal(diskDaysLeft({
    free_bytes: 100 * GB,
    total_bytes: 465 * GB,
    bytes_per_day: 31 * GB,
    recording_bytes: null,
  }), 3.2);
  assert.equal(diskDaysLeft({ free_bytes: 1, total_bytes: 2, bytes_per_day: null, recording_bytes: null }), null);
});

// ── Ổ đĩa máy kho ──────────────────────────────────────────────────────

const disk = (freeGb: number, totalGb: number, perDayGb: number | null) =>
  report({ disk: { free_bytes: freeGb * GB, total_bytes: totalGb * GB, bytes_per_day: perDayGb === null ? null : perDayGb * GB } });

test("ổ: đủ chỗ → ok; < 7 ngày → warn; < 3 ngày → crit (quyết định #5)", () => {
  assert.equal(diskEntity(row({ self_report: disk(300, 465, 31) }), NOW).status, "ok");
  assert.equal(diskEntity(row({ self_report: disk(150, 465, 31) }), NOW).status, "warn");
  assert.equal(diskEntity(row({ self_report: disk(60, 465, 31) }), NOW).status, "crit");
  assert.match(diskEntity(row({ self_report: disk(60, 465, 31) }), NOW).action ?? "", /script dọn ổ/);
});

test("ổ: chưa đủ số liệu tốc độ → phán theo % trống", () => {
  assert.equal(diskEntity(row({ self_report: disk(100, 465, null) }), NOW).status, "ok");
  assert.equal(diskEntity(row({ self_report: disk(30, 465, null) }), NOW).status, "warn");
  assert.equal(diskEntity(row({ self_report: disk(10, 465, null) }), NOW).status, "crit");
});

test("ổ: máy bản cũ / bản khai cũ → BỎ QUA (mục agent_fleet đã báo), không thành 'chưa rõ'", () => {
  assert.equal(diskEntity(row({ self_report: null }), NOW).status, "skipped");
  assert.equal(
    diskEntity(row({ self_report: disk(10, 465, 31), self_report_at: minutesAgo(CHECK_CONFIG.selfReport.diskReportMaxAgeMinutes + 1) }), NOW).status,
    "skipped",
  );
});

// ── Bản agent & hàng đợi ───────────────────────────────────────────────

test("bản mới nhất, hàng đợi rỗng → ok", () => {
  assert.equal(fleetEntity(row(), NOW, 0).status, "ok");
});

test("bản cũ chưa biết tự khai → warn, câu cần làm là cài bản mới", () => {
  const e = fleetEntity(row({ self_report: null, agent_version: null, self_report_at: null }), NOW, 0);
  assert.equal(e.status, "warn");
  assert.match(e.detail, /chưa biết tự khai/);
  assert.match(e.action ?? "", new RegExp(`Cài agent ${LATEST_AGENT_VERSION.replaceAll(".", "\\.")}`));
});

test("bản thấp hơn mới nhất → warn", () => {
  const e = fleetEntity(row({ self_report: report({ version: "0.12.9" }) }), NOW, 0);
  assert.equal(e.status, "warn");
  assert.match(e.detail, /Chạy bản 0\.12\.9/);
});

test("vẫn ping mà ngừng tự khai → warn", () => {
  const e = fleetEntity(row({ self_report_at: minutesAgo(40), last_seen_at: minutesAgo(1) }), NOW, 0);
  assert.equal(e.status, "warn");
  assert.match(e.detail, /ngừng tự khai 40 phút/);
});

test("lệnh cắt clip ùn: cloud tự đếm — áp cả với agent bản cũ", () => {
  const old = row({ self_report: null, agent_version: null, self_report_at: null });
  assert.match(fleetEntity(old, NOW, CHECK_CONFIG.selfReport.queueWarn).detail, /clip chờ cắt/);
  assert.equal(fleetEntity(row(), NOW, CHECK_CONFIG.selfReport.queueCrit).status, "crit");
  assert.equal(fleetEntity(row(), NOW, CHECK_CONFIG.selfReport.queueWarn - 1).status, "ok");
});

test("lượt quét chờ gửi ùn → nói rõ là mạng kho", () => {
  const e = fleetEntity(row({ self_report: report({ queues: { scans_pending: 25 } }) }), NOW, 0);
  assert.equal(e.status, "warn");
  assert.match(e.action ?? "", /mạng kho/);
});

const scope: MonitoringScope = {
  orgIds: ["org-a"],
  orgNameById: new Map([["org-a", "Betacom"]]),
  warehouseNamesByOrg: new Map(),
  lastScanByOrg: new Map(),
};

function fakeDb(opts: { agents?: FleetAgentRow[]; agentError?: { code?: string; message: string }; cmds?: unknown[] }) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "abortSignal", "order", "limit"]) q[m] = () => q;
      q.then = (res: (v: unknown) => void) => {
        if (table === "warehouse_agents") {
          return res(opts.agentError ? { data: null, error: opts.agentError } : { data: opts.agents ?? [], error: null });
        }
        return res({ data: opts.cmds ?? [], error: null });
      };
      return q;
    },
  } as never;
}

test("cả mục: chưa chạy migration → 'chưa đo được' dạng cấu trúc, nói đúng migration", async () => {
  const c = await checkAgentFleet(
    fakeDb({ agentError: { code: "42703", message: "column warehouse_agents.self_report does not exist" } }),
    NOW,
    scope,
  );
  assert.equal(c.status, "unknown");
  assert.equal(c.unknownKind, "structural");
  assert.match(c.message, /20260926130000/);
});

test("cả mục: đếm lệnh cắt clip đang ùn theo từng agent", async () => {
  const cmds = Array.from({ length: 21 }, () => ({ agent_id: "ag-1" }));
  const c = await checkAgentFleet(fakeDb({ agents: [row()], cmds }), NOW, scope);
  assert.equal(c.status, "warn");
  assert.match(c.message, /21 clip chờ cắt/);
});

// ── Trần kiện hoàn theo khả năng ───────────────────────────────────────

function capDb(opts: { agentId?: string | null; selfReport?: unknown; error?: boolean }) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => {
        if (table === "cameras") return { data: opts.agentId === undefined ? null : { agent_id: opts.agentId }, error: null };
        if (opts.error) return { data: null, error: { code: "42703", message: "column self_report does not exist" } };
        return { data: { self_report: opts.selfReport ?? null }, error: null };
      };
      return q;
    },
  } as never;
}

test("kiện hoàn 310s CHỈ khi agent cắt clip tự khai hạ được bitrate", async () => {
  assert.equal(await returnClipCapSeconds(capDb({ agentId: "a", selfReport: report() }), "cam", 180), MAX_RETURN_CLIP_DURATION_SECONDS);
  assert.equal(await returnClipCapSeconds(capDb({ agentId: "a", selfReport: report({ capabilities: [] }) }), "cam", 180), 180);
});

test("mọi nhánh không chắc → giữ trần chung (thận trọng)", async () => {
  assert.equal(await returnClipCapSeconds(capDb({}), null, 180), 180, "không biết camera");
  assert.equal(await returnClipCapSeconds(capDb({ agentId: null }), "cam", 180), 180, "camera không gắn agent");
  assert.equal(await returnClipCapSeconds(capDb({ agentId: "a", error: true }), "cam", 180), 180, "chưa có cột");
  assert.equal(await returnClipCapSeconds(capDb({ agentId: "a", selfReport: null }), "cam", 180), 180, "agent bản cũ");
});

test("bộ cắt clip áp trần theo khả năng cho kiện hoàn, trần chung cho đơn đi", () => {
  const src = readFileSync("src/lib/order-proof/clip-resolver.ts", "utf8");
  assert.ok(src.includes('packingEvent.event_kind === "return"'));
  assert.ok(src.includes("const maxClipEndMs = clipStart.getTime() + capSeconds * 1000;"));
});

test("trần kiện hoàn của TỔ CHỨC: mọi agent active phải có khả năng", () => {
  const f = (id: string, org: string, caps: string[], status = "active"): FleetRow => ({
    id, code: id, name: null, organization_id: org, status, last_seen_at: null,
    self_report: report({ capabilities: caps }), self_report_at: null, agent_version: null,
  });
  const m = returnClipSecondsByOrg(
    [
      f("a1", "o1", [CAPABILITY.adaptiveClipBitrate]),
      f("a2", "o1", [CAPABILITY.adaptiveClipBitrate]),
      f("b1", "o2", [CAPABILITY.adaptiveClipBitrate]),
      f("b2", "o2", []),
      f("c1", "o3", [], "disabled"),
    ],
    180,
  );
  assert.equal(m.get("o1"), MAX_RETURN_CLIP_DURATION_SECONDS);
  assert.equal(m.get("o2"), 180, "một máy chưa lên bản mới là chưa được");
  assert.equal(m.has("o3"), false, "agent tắt không tính");
});

test("Đặt / Thực dùng: agent đã hạ được bitrate → hết câu 'clip kiện hoàn cụt'", () => {
  const wh = { packing_timing_config: { return_max_seconds: 300 }, session_fallback_seconds: null };
  const before = resolveWarehouseParams(wh, 180).find((p) => p.key === "return_max_seconds")!;
  const after = resolveWarehouseParams(wh, 180, MAX_RETURN_CLIP_DURATION_SECONDS).find((p) => p.key === "return_max_seconds")!;
  assert.match(before.consequence ?? "", /175s đầu/);
  assert.equal(after.consequence, null);
});

// ── Đội agent ──────────────────────────────────────────────────────────

test("Đội agent: khớp camera theo id hoặc mã, nêu camera không ghi, đánh dấu bản cũ", () => {
  const v = buildFleetViewRow(
    {
      id: "ag", code: "AG", name: null, organization_id: "o", status: "active", last_seen_at: minutesAgo(1),
      self_report: report({ version: "0.12.9", cameras: [{ code: "cam-1", recording: true }, { code: "CQR01", recording: true }] }),
      self_report_at: minutesAgo(1), agent_version: "0.12.9",
    },
    {
      orgName: "Betacom",
      declaredCameras: [{ id: "cam-1", code: "CTC01" }, { id: "cam-2", code: "CQR01" }, { id: "cam-3", code: "CTC02" }],
      openIncidents: { crit: 0, warn: 1 },
    },
  );
  assert.deepEqual(v.cameras, { declared: 3, recording: 2, notRecording: ["CTC02"] });
  assert.equal(v.outdated, true);
});

test("Đội agent: máy chưa tự khai → 'chưa rõ', không đoán là không ghi", () => {
  const v = buildFleetViewRow(
    { id: "ag", code: "AG", name: null, organization_id: "o", status: "active", last_seen_at: null, self_report: null, self_report_at: null, agent_version: null },
    { orgName: "x", declaredCameras: [{ id: "c", code: "C" }], openIncidents: { crit: 0, warn: 0 } },
  );
  assert.equal(v.cameras.recording, null);
  assert.deepEqual(v.cameras.notRecording, []);
  assert.equal(v.version, null);
  assert.equal(v.outdated, true);
});

// ── Nhịp tim, lệnh chẩn đoán, migration ────────────────────────────────

test("nhịp tim: chỉ thêm bản khai khi có; chưa có cột thì lưu như cũ", () => {
  const src = readFileSync("src/app/api/warehouse/heartbeat/route.ts", "utf8");
  assert.ok(src.includes("const withReport = selfReport"));
  assert.ok(src.includes('["self_report", "agent_version"].some((c) => isMissingColumnError(seenErr, c))'));
  assert.ok(src.includes('.update(updates).eq("id", agent.id)'), "đường lùi ghi đúng bản cũ");
  assert.ok(hasCapability({ capabilities: ["x"] }, "x"));
});

test("lệnh chẩn đoán: chặn agent bản cũ, audit, chỉ đọc", () => {
  const src = readFileSync("src/app/api/platform/agents/[id]/diagnostics/route.ts", "utf8");
  assert.ok(src.includes("hasCapability(parseSelfReport(agent.self_report), CAPABILITY.diagnostics)"));
  assert.ok(src.includes('type: "collect_diagnostics"'));
  assert.ok(src.includes('action: "platform.agent.collect_diagnostics"'));
});

test("migration: ba cột + mở loại lệnh collect_diagnostics theo khuôn không đoán danh sách", () => {
  const sql = readFileSync("supabase/migrations/20260926130000_agent_self_report.sql", "utf8");
  for (const col of ["self_report    jsonb", "self_report_at timestamptz", "agent_version  text"]) {
    assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
  }
  assert.ok(sql.includes("IF NOT ('collect_diagnostics' = ANY (v_types)) THEN"));
  assert.ok(sql.includes("khong tim thay rang buoc agent_commands_type_check"));
});
