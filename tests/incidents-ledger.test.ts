import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideResolution,
  incidentCandidates,
  readOpenIncidents,
  syncIncidents,
  type ActiveIncident,
} from "@/lib/system/incidents";
import type { CheckEntity, SystemCheck } from "@/lib/system/checks";
import type { SystemIssue } from "@/lib/system/status-view";

/**
 * Sổ sự cố — kế hoạch VAN-HANH-NHIEU-KHO, đợt 3.
 *
 * Ba luật, mỗi luật chặn một kiểu hỏng đã biết:
 *   1. Chỉ crit / warn thành sự cố — "chưa đo được" thì không. Đo 26/09/2026:
 *      một lượt 12 mục song song có một mục mất nguồn vì mạng chập, sáu lượt
 *      sau đều sạch. Ghi cả unknown là sổ đầy dòng mở-rồi-đóng vô nghĩa.
 *   2. Chỉ đóng khi có BẰNG CHỨNG DƯƠNG. Kho vào giờ nghỉ (skipped) không có
 *      nghĩa camera đã khoẻ — đóng lúc đó là mất mốc bắt đầu thật.
 *   3. Gom theo issue_key: sự cố kéo dài là MỘT dòng, đếm lượt tăng dần.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-26T08:00:00Z");

const issue = (p: Partial<SystemIssue> & Pick<SystemIssue, "id" | "checkKey" | "status">): SystemIssue => ({
  where: "Kho A",
  what: "CAM-1",
  symptom: "Không phản hồi RTSP",
  action: "Kiểm nguồn camera",
  href: null,
  orgId: ORG,
  entityId: null,
  ...p,
});

const entity = (id: string, status: CheckEntity["status"]): CheckEntity => ({
  kind: "camera",
  id,
  code: id,
  orgId: ORG,
  status,
  detail: "",
});

const check = (key: string, status: SystemCheck["status"], entities?: CheckEntity[]): SystemCheck => ({
  key,
  status,
  value: "",
  message: "",
  ...(entities ? { entities } : {}),
});

// ── Luật 1 ─────────────────────────────────────────────────────────────

test("chỉ crit / warn thành sự cố — 'chưa đo được' thì không", () => {
  const out = incidentCandidates([
    issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "crit", entityId: "a" }),
    issue({ id: "clip_failures:o", checkKey: "clip_failures", status: "warn", entityId: ORG }),
    issue({ id: "config_health", checkKey: "config_health", status: "unknown" }),
  ]);
  assert.deepEqual(out.map((c) => c.issueKey), ["camera_probe:a", "clip_failures:o"]);
  assert.equal(out[0].entityId, "a", "phải mang id đối tượng để lượt sau đóng được");
  assert.equal(out[0].orgId, ORG, "phải mang tổ chức để gom theo shop");
});

// ── Luật 2 ─────────────────────────────────────────────────────────────

test("đối tượng khoẻ lại (ok) → đóng, lý do auto_ok", () => {
  const d = decideResolution({ check_key: "camera_probe", entity_id: "a" }, [
    check("camera_probe", "ok", [entity("a", "ok")]),
  ]);
  assert.deepEqual(d, { resolve: true, reason: "auto_ok" });
});

test("kho vào giờ nghỉ (skipped) → GIỮ NGUYÊN, không đóng", () => {
  // Camera hỏng lúc 17h, kho nghỉ lúc 18h: đóng ở đây là sáng mai mở dòng
  // MỚI, mất mốc bắt đầu thật — đúng thứ luật 2 sinh ra để chặn.
  const d = decideResolution({ check_key: "camera_probe", entity_id: "a" }, [
    check("camera_probe", "ok", [entity("a", "skipped")]),
  ]);
  assert.equal(d.resolve, false);
});

test("mục kiểm mất nguồn (unknown) → GIỮ NGUYÊN, không có bằng chứng", () => {
  const d = decideResolution({ check_key: "camera_probe", entity_id: "a" }, [
    check("camera_probe", "unknown"),
  ]);
  assert.equal(d.resolve, false);
});

test("đối tượng biến mất mà mục kiểm vẫn chạy → out_of_scope, KHÔNG phải auto_ok", () => {
  // Camera đã lưu trữ, tổ chức tắt theo dõi. Ghi là "đã khỏi" là nói dối.
  const d = decideResolution({ check_key: "camera_probe", entity_id: "a" }, [
    check("camera_probe", "ok", [entity("b", "ok")]),
  ]);
  assert.deepEqual(d, { resolve: true, reason: "out_of_scope" });
});

test("mục kiểm không còn trong bộ → out_of_scope, không để mở mãi", () => {
  const d = decideResolution({ check_key: "muc_da_go", entity_id: null }, [check("camera_probe", "ok")]);
  assert.deepEqual(d, { resolve: true, reason: "out_of_scope" });
});

test("mục cấp hệ thống: ok → đóng; còn warn → giữ", () => {
  assert.deepEqual(
    decideResolution({ check_key: "cron_orphan_segments", entity_id: null }, [check("cron_orphan_segments", "ok")]),
    { resolve: true, reason: "auto_ok" },
  );
  assert.equal(
    decideResolution({ check_key: "cron_orphan_segments", entity_id: null }, [check("cron_orphan_segments", "warn")]).resolve,
    false,
  );
});

// ── Vòng đồng bộ với database giả ──────────────────────────────────────

interface Write {
  op: "insert" | "update";
  values: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

function fakeAdmin(opts: {
  active?: ActiveIncident[];
  readError?: { code?: string; message: string };
  insertError?: { code?: string; message: string };
  throwOnRead?: boolean;
}) {
  const writes: Write[] = [];
  const admin = {
    from() {
      let mode: "select" | "insert" | "update" = "select";
      let values: Record<string, unknown> = {};
      const filters: Array<[string, string, unknown]> = [];
      const q: Record<string, unknown> = {
        select() { mode = "select"; return q; },
        insert(v: Record<string, unknown>) { mode = "insert"; values = v; return q; },
        update(v: Record<string, unknown>) { mode = "update"; values = v; return q; },
        eq(c: string, v: unknown) { filters.push([c, "eq", v]); return q; },
        in(c: string, v: unknown) { filters.push([c, "in", v]); return q; },
        order() { return q; },
        limit() { return q; },
        then(res: (v: unknown) => void, rej: (e: unknown) => void) {
          if (mode === "select") {
            if (opts.throwOnRead) return rej(new Error("fetch failed"));
            if (opts.readError) return res({ data: null, error: opts.readError });
            return res({ data: opts.active ?? [], error: null, count: (opts.active ?? []).length });
          }
          writes.push({ op: mode, values, filters: [...filters] });
          return res({ error: mode === "insert" ? (opts.insertError ?? null) : null });
        },
      };
      return q;
    },
  };
  return { admin: admin as never, writes };
}

const activeRow = (p: Partial<ActiveIncident> & Pick<ActiveIncident, "id" | "issue_key">): ActiveIncident => ({
  check_key: "camera_probe",
  entity_id: "a",
  severity: "warn",
  peak_severity: "warn",
  occurrence_count: 1,
  ...p,
});

test("lượt đầu: mở dòng mới, đủ trường, đếm = 1", async () => {
  const { admin, writes } = fakeAdmin({ active: [] });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "crit", [entity("a", "crit")])],
    issues: [issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "crit", entityId: "a" })],
    now: NOW,
  });
  assert.equal(s.opened, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, "insert");
  assert.equal(writes[0].values.issue_key, "camera_probe:a");
  assert.equal(writes[0].values.organization_id, ORG);
  assert.equal(writes[0].values.entity_id, "a");
  assert.equal(writes[0].values.peak_severity, "crit");
  assert.equal(writes[0].values.first_seen_at, NOW.toISOString());
});

test("lượt sau cùng sự cố: GOM vào dòng cũ, không mở dòng mới", async () => {
  const { admin, writes } = fakeAdmin({
    active: [activeRow({ id: "r1", issue_key: "camera_probe:a", occurrence_count: 7 })],
  });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "warn", [entity("a", "warn")])],
    issues: [issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "warn", entityId: "a" })],
    now: NOW,
  });
  assert.equal(s.opened, 0);
  assert.equal(s.bumped, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, "update");
  assert.equal(writes[0].values.occurrence_count, 8);
  assert.equal(writes[0].values.last_seen_at, NOW.toISOString());
  assert.deepEqual(writes[0].filters, [["id", "eq", "r1"]]);
});

test("mức nặng nhất được giữ: từng crit rồi về warn thì peak vẫn crit", async () => {
  const { admin, writes } = fakeAdmin({
    active: [activeRow({ id: "r1", issue_key: "camera_probe:a", severity: "crit", peak_severity: "crit" })],
  });
  await syncIncidents(admin, {
    checks: [check("camera_probe", "warn", [entity("a", "warn")])],
    issues: [issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "warn", entityId: "a" })],
    now: NOW,
  });
  assert.equal(writes[0].values.severity, "warn");
  assert.equal(writes[0].values.peak_severity, "crit");
});

test("khoẻ lại → đóng auto_ok, và không ghi đè dòng người trực vừa đóng tay", async () => {
  const { admin, writes } = fakeAdmin({ active: [activeRow({ id: "r1", issue_key: "camera_probe:a" })] });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "ok", [entity("a", "ok")])],
    issues: [],
    now: NOW,
  });
  assert.equal(s.resolvedOk, 1);
  assert.equal(writes[0].values.status, "resolved");
  assert.equal(writes[0].values.resolved_reason, "auto_ok");
  assert.ok(
    writes[0].filters.some(([c, op]) => c === "status" && op === "in"),
    "phải chỉ đóng dòng còn đang mở — đợt 4 có nút đóng tay",
  );
});

test("kho nghỉ → GIỮ, không ghi gì", async () => {
  const { admin, writes } = fakeAdmin({ active: [activeRow({ id: "r1", issue_key: "camera_probe:a" })] });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "ok", [entity("a", "skipped")])],
    issues: [],
    now: NOW,
  });
  assert.equal(s.kept, 1);
  assert.equal(writes.length, 0);
});

test("chưa chạy migration → báo lỗi, KHÔNG ghi mù", async () => {
  // Không đọc được sổ mà vẫn ghi là đẻ dòng trùng khi sổ có lại.
  const { admin, writes } = fakeAdmin({ readError: { code: "PGRST205", message: "no table" } });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "crit", [entity("a", "crit")])],
    issues: [issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "crit", entityId: "a" })],
    now: NOW,
  });
  assert.equal(writes.length, 0);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /đọc sổ/);
});

test("mạng đứt lúc đọc sổ → không ném, route vẫn chạy tiếp", async () => {
  const { admin } = fakeAdmin({ throwOnRead: true });
  const s = await syncIncidents(admin, { checks: [], issues: [], now: NOW });
  assert.equal(s.errors.length, 1);
});

test("lượt khác vừa mở cùng sự cố (23505) → bỏ qua, không tính lỗi", async () => {
  const { admin } = fakeAdmin({ active: [], insertError: { code: "23505", message: "duplicate" } });
  const s = await syncIncidents(admin, {
    checks: [check("camera_probe", "crit", [entity("a", "crit")])],
    issues: [issue({ id: "camera_probe:a", checkKey: "camera_probe", status: "crit", entityId: "a" })],
    now: NOW,
  });
  assert.equal(s.opened, 0);
  assert.equal(s.errors.length, 0);
});

// ── Đường đọc ──────────────────────────────────────────────────────────

test("đọc sổ khi chưa có bảng → nói thẳng là chưa chạy migration, không hiện '0 sự cố'", async () => {
  // "0 sự cố" nghĩa là khoẻ. Chưa có sổ thì phải nói là chưa có sổ.
  for (const code of ["42P01", "PGRST205"]) {
    const { admin } = fakeAdmin({ readError: { code, message: "missing" } });
    const v = await readOpenIncidents(admin);
    assert.equal(v.available, false);
    assert.match(v.available ? "" : v.reason, /migration 20260926100000/);
  }
});

// ── Dây nối ────────────────────────────────────────────────────────────

test("route tự kiểm ghi sổ SAU khi gửi Lark — sổ hỏng không làm mất tin cảnh báo", () => {
  const src = readFileSync("src/app/api/system/check/route.ts", "utf8");
  const lark = src.indexOf("alert = await sendSystemAlert(");
  const ledger = src.indexOf("await syncIncidents(admin");
  assert.ok(lark > 0 && ledger > 0);
  assert.ok(lark < ledger, "phải gửi Lark trước");
  assert.ok(src.includes("issues: buildIssues(checks, scope)"), "sổ phải ghi đúng danh sách Cần chú ý");
  assert.ok(src.includes("incidents,"), "tóm tắt sổ phải vào dòng system_jobs để lần theo");
});

test("trang Tình trạng chỉ ĐỌC sổ — mở trang không được ghi", () => {
  const src = readFileSync("src/app/api/system/status/route.ts", "utf8");
  assert.ok(src.includes("readOpenIncidents("));
  assert.ok(!src.includes("syncIncidents("), "route trạng thái mà ghi sổ thì mỗi người mở trang đẻ một lượt ghi");
  const page = readFileSync("src/app/platform/system/page.tsx", "utf8");
  assert.ok(page.includes("<IncidentLedgerPanel"), "trang phải hiện ô Sổ sự cố");
});

test("migration: một dòng đang mở mỗi sự cố, không mức unknown, không policy nào", () => {
  const sql = readFileSync("supabase/migrations/20260926100000_warehouse_incidents.sql", "utf8");
  assert.ok(sql.includes("ON public.warehouse_incidents (issue_key)\n  WHERE status IN ('open', 'acknowledged');"));
  assert.ok(sql.includes("CHECK (severity IN ('crit', 'warn'))"));
  assert.ok(sql.includes("ENABLE ROW LEVEL SECURITY"));
  assert.ok(!/CREATE POLICY/i.test(sql), "không được có policy — khách không đọc được sổ");
});
