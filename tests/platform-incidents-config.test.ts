import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  buildTimingPatch,
  retentionFieldError,
  sessionFallbackFrom,
} from "@/lib/config/validate";
import {
  editOrgConfig,
  editWarehouseConfig,
  parseOrgConfigBody,
  parseWarehouseConfigBody,
} from "@/lib/platform/config-edit";
import {
  ALLOWED_FROM,
  conflictMessage,
  listIncidents,
  parseStatusFilter,
  transitionIncident,
  transitionPatch,
} from "@/lib/system/incident-actions";
import { spanLabel } from "@/lib/format/time-vn";
import { paramsNeedAttention as needsAttention, type EffectiveParam } from "@/lib/config/effective";

/**
 * Đợt 4 — kế hoạch VAN-HANH-NHIEU-KHO: trang Sự cố (Ghi nhận / Đã xử lý) và
 * cấu hình mọi kho sửa được từ platform, audit ghi đúng admin nền tảng.
 */

const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = new Date("2026-09-26T09:00:00Z");

// ── Bản giả Supabase trong bộ nhớ: bộ lọc và cập nhật chạy THẬT ────────

type Row = Record<string, unknown>;

function memoryAdmin(tables: Record<string, Row[]>, opts: { failUpdate?: string } = {}) {
  const admin = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      const preds: Array<(r: Row) => boolean> = [];
      let limit = Infinity;
      const matches = () => rows.filter((r) => preds.every((p) => p(r)));
      const run = () => {
        if (mode === "update") {
          if (opts.failUpdate === table) return { data: null, error: { message: "boom" } };
          const hit = matches();
          for (const r of hit) Object.assign(r, structuredClone(patch));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        return { data: matches().slice(0, limit).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q,
        update: (v: Row) => ((mode = "update"), (patch = v), q),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), q),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        maybeSingle: async () => {
          const { data, error } = run();
          return { data: data?.[0] ?? null, error };
        },
        single: async () => {
          const { data, error } = run();
          if (error) return { data: null, error };
          return data?.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "not single" } };
        },
        then: (res: (v: unknown) => void) => res(run()),
      };
      return q;
    },
  };
  return admin as never;
}

// ============================================================================
// Luật kiểm dùng chung — hành vi PHẢI giữ y hệt bản cũ trong route tenant
// ============================================================================

test("hạn lưu: 7–365 số nguyên, null là bỏ cấu hình", () => {
  assert.equal(retentionFieldError("retention_days", null), null);
  assert.equal(retentionFieldError("retention_days", RETENTION_MIN_DAYS), null);
  assert.equal(retentionFieldError("retention_days", RETENTION_MAX_DAYS), null);
  for (const bad of [6, 366, 7.5, "30", undefined, Number.NaN]) {
    assert.match(retentionFieldError("return_retention_days", bad) ?? "", /return_retention_days phải là số nguyên trong khoảng 7-365/);
  }
});

test("thời gian kho: kẹp y hệt bản cũ (60–3600, 0–120, 1–600), làm tròn xuống, bỏ ô không phải số", () => {
  assert.deepEqual(buildTimingPatch({ max_order_seconds: 30, video_pre_seconds: -3, video_default_post_seconds: 0 }), {
    max_order_seconds: 60,
    video_pre_seconds: 0,
    video_default_post_seconds: 1,
  });
  assert.deepEqual(buildTimingPatch({ max_order_seconds: 9999, video_pre_seconds: 500, video_default_post_seconds: 9999 }), {
    max_order_seconds: 3600,
    video_pre_seconds: 120,
    video_default_post_seconds: 600,
  });
  assert.deepEqual(buildTimingPatch({ max_order_seconds: 200.9, video_pre_seconds: "5", return_max_seconds: 310 }), {
    max_order_seconds: 200,
  }, "chuỗi bị bỏ; ô không mở (return_max_seconds) KHÔNG lọt qua");
  assert.equal(buildTimingPatch({ video_pre_seconds: Infinity }), null);
  assert.equal(buildTimingPatch(null), null);
  assert.equal(buildTimingPatch("x"), null);
});

test("session_fallback_seconds: số dương làm tròn xuống, còn lại bỏ qua", () => {
  assert.equal(sessionFallbackFrom(45.7), 45);
  assert.equal(sessionFallbackFrom(0), null);
  assert.equal(sessionFallbackFrom(-5), null);
  assert.equal(sessionFallbackFrom("30"), null);
});

test("route tenant dùng CHUNG luật — không còn bản chép riêng", () => {
  const org = readFileSync("src/app/api/organization/route.ts", "utf8");
  assert.ok(org.includes("retentionFieldError(field, update[field])"));
  assert.ok(!org.includes("const RETENTION_MIN_DAYS"), "hằng số cũ phải bỏ khỏi route");
  const wh = readFileSync("src/app/api/warehouses/[id]/route.ts", "utf8");
  assert.ok(wh.includes("buildTimingPatch(body.packing_timing_config)"));
  assert.ok(wh.includes("sessionFallbackFrom(body.session_fallback_seconds)"));
  assert.ok(!wh.includes("const clamp ="), "hàm kẹp cũ phải bỏ khỏi route");
});

// ============================================================================
// Sửa cấu hình từ platform
// ============================================================================

test("tổ chức: body rỗng / sai luật bị chặn trước khi chạm DB", () => {
  assert.equal(parseOrgConfigBody(null).ok, false);
  assert.equal(parseOrgConfigBody({ name: "đổi tên" }).ok, false, "platform không sửa tên qua đường này");
  const bad = parseOrgConfigBody({ retention_days: 3 });
  assert.equal(bad.ok, false);
  const ok = parseOrgConfigBody({ return_retention_days: 30, logo_url: "x" });
  assert.deepEqual(ok, { ok: true, update: { return_retention_days: 30 } });
});

test("tổ chức: sửa đúng dòng, trả trước / sau và bảng Đặt / Thực dùng mới", async () => {
  const tables = {
    organizations: [
      { id: ORG_A, name: "Shop A", retention_days: 30, return_retention_days: null },
      { id: ORG_B, name: "Shop B", retention_days: 14, return_retention_days: 7 },
    ],
    warehouses: [{ id: "w1", organization_id: ORG_A, packing_timing_config: {} }],
  };
  const r = await editOrgConfig(memoryAdmin(tables), ORG_A, { return_retention_days: 45 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.before, { return_retention_days: null });
  assert.deepEqual(r.after, { return_retention_days: 45 });
  assert.equal(r.orgName, "Shop A");
  const p = r.params.find((x) => x.key === "return_retention_days")!;
  assert.equal(p.source, "set");
  assert.equal(p.effective, 45);
  assert.equal(tables.organizations[1].return_retention_days, 7, "tổ chức khác không bị đụng");
});

test("tổ chức không tồn tại → 404, không ghi gì", async () => {
  const r = await editOrgConfig(memoryAdmin({ organizations: [] }), ORG_A, { retention_days: 30 });
  assert.deepEqual(r.ok ? null : [r.status, r.error], [404, "not_found"]);
});

test("kho: CHẶN sửa chéo — id kho của tổ chức B ghép vào đường dẫn tổ chức A → 404, B nguyên vẹn", async () => {
  const tables = {
    warehouses: [
      { id: "wB", code: "KHO_B", organization_id: ORG_B, packing_timing_config: { max_order_seconds: 180 }, session_fallback_seconds: null },
    ],
  };
  const r = await editWarehouseConfig(memoryAdmin(tables), ORG_A, "wB", { packing_timing_config: { max_order_seconds: 600 } });
  assert.equal(r.ok ? 200 : r.status, 404);
  assert.deepEqual(tables.warehouses[0].packing_timing_config, { max_order_seconds: 180 });
});

test("kho: merge JSON giữ các khoá kỹ thuật không mở, audit trước / sau đúng ô đã sửa", async () => {
  const tables = {
    warehouses: [
      {
        id: "w1",
        code: "KHO_HN_01",
        organization_id: ORG_A,
        packing_timing_config: { max_order_seconds: 180, return_max_seconds: 300, timing_strategy: "x" },
        session_fallback_seconds: null,
      },
    ],
  };
  const r = await editWarehouseConfig(memoryAdmin(tables), ORG_A, "w1", {
    packing_timing_config: { video_pre_seconds: 8 },
    session_fallback_seconds: 40,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(tables.warehouses[0].packing_timing_config, {
    max_order_seconds: 180,
    return_max_seconds: 300,
    timing_strategy: "x",
    video_pre_seconds: 8,
  });
  assert.deepEqual(r.before, { video_pre_seconds: null, session_fallback_seconds: null });
  assert.deepEqual(r.after, { video_pre_seconds: 8, session_fallback_seconds: 40 });
  assert.equal(r.warehouseCode, "KHO_HN_01");
  assert.equal(r.params.find((p) => p.key === "video_pre_seconds")?.effective, 8);
});

test("kho: body không có ô sửa được → 400", () => {
  assert.equal(parseWarehouseConfigBody({ packing_timing_config: { return_max_seconds: 310 } }).ok, false);
  assert.equal(parseWarehouseConfigBody({ notify_lark_webhook_url: "x" }).ok, false, "webhook không sửa qua đường này");
});

test("route platform: owner mới sửa được, lấy org từ ĐƯỜNG DẪN, audit ghi admin nền tảng + trước/sau", () => {
  for (const p of [
    "src/app/api/platform/orgs/[id]/config/route.ts",
    "src/app/api/platform/orgs/[id]/warehouses/[warehouseId]/config/route.ts",
  ]) {
    const src = readFileSync(p, "utf8");
    assert.ok(src.includes('requirePlatformRole("platform_owner")'), `${p}: phải gate platform_owner`);
    assert.ok(src.includes("await params"), `${p}: org lấy từ đường dẫn`);
    assert.ok(!src.includes("ctx.organizationId"), `${p}: không được lấy org từ phiên`);
    assert.ok(src.includes("logPlatformAudit({"), `${p}: phải ghi platform_audit_log`);
    assert.ok(src.includes("actorUserId: ctx.userId") && src.includes("actorEmail: ctx.email"));
    assert.ok(src.includes("before: result.before") && src.includes("after: result.after"));
    assert.ok(src.includes('targetType: "organization"') && src.includes("targetId: orgId"),
      "gắn vào tổ chức để hiện ở tab nhật ký của trang chi tiết tổ chức");
    assert.ok(!src.includes('from "@/lib/audit"'), "không ghi vào audit_logs của khách như thể chủ tổ chức tự sửa");
  }
});

// ============================================================================
// Sự cố: Ghi nhận / Đã xử lý
// ============================================================================

const incident = (p: Row): Row => ({
  id: "i1",
  issue_key: "camera_probe:c1",
  check_key: "camera_probe",
  organization_id: ORG_A,
  status: "open",
  severity: "warn",
  acknowledged_at: null,
  acknowledged_by: null,
  resolved_at: null,
  resolved_reason: null,
  ...p,
});

test("luật chuyển: ghi nhận chỉ từ open; đóng từ open hoặc đã ghi nhận", () => {
  assert.deepEqual(ALLOWED_FROM.acknowledge, ["open"]);
  assert.deepEqual(ALLOWED_FROM.resolve, ["open", "acknowledged"]);
  assert.deepEqual(transitionPatch("acknowledge", "u1", NOW), {
    status: "acknowledged",
    acknowledged_at: NOW.toISOString(),
    acknowledged_by: "u1",
  });
  // Đóng tay: đủ cả giờ đóng và lý do — ràng buộc nhất quán của bảng đòi thế.
  assert.deepEqual(transitionPatch("resolve", "u1", NOW), {
    status: "resolved",
    resolved_at: NOW.toISOString(),
    resolved_reason: "manual",
  });
});

test("ghi nhận: open → acknowledged, lưu người nhận", async () => {
  const tables = { warehouse_incidents: [incident({})] };
  const r = await transitionIncident(memoryAdmin(tables), "i1", "acknowledge", "admin-1", NOW);
  assert.equal(r.ok, true);
  assert.equal(tables.warehouse_incidents[0].status, "acknowledged");
  assert.equal(tables.warehouse_incidents[0].acknowledged_by, "admin-1");
});

test("hai người cùng bấm Ghi nhận: người sau nhận 409, KHÔNG ghi đè người trước", async () => {
  const tables = { warehouse_incidents: [incident({ status: "acknowledged", acknowledged_by: "admin-1" })] };
  const r = await transitionIncident(memoryAdmin(tables), "i1", "acknowledge", "admin-2", NOW);
  assert.equal(r.ok ? 200 : r.status, 409);
  assert.equal(tables.warehouse_incidents[0].acknowledged_by, "admin-1");
  assert.equal(r.ok ? "" : r.message, "Sự cố đã có người ghi nhận.");
});

test("lượt tự kiểm vừa đóng (auto_ok) rồi người trực bấm Đã xử lý: 409, giữ lý do auto_ok", async () => {
  const tables = {
    warehouse_incidents: [incident({ status: "resolved", resolved_at: NOW.toISOString(), resolved_reason: "auto_ok" })],
  };
  const r = await transitionIncident(memoryAdmin(tables), "i1", "resolve", "admin-1", NOW);
  assert.equal(r.ok ? 200 : r.status, 409);
  assert.equal(tables.warehouse_incidents[0].resolved_reason, "auto_ok");
  assert.match(r.ok ? "" : r.message, /đã được đóng trước đó/);
});

test("đóng tay từ trạng thái đã ghi nhận", async () => {
  const tables = { warehouse_incidents: [incident({ status: "acknowledged" })] };
  const r = await transitionIncident(memoryAdmin(tables), "i1", "resolve", "admin-1", NOW);
  assert.equal(r.ok, true);
  assert.equal(tables.warehouse_incidents[0].resolved_reason, "manual");
});

test("sự cố không tồn tại → 404; DB lỗi → 500 chứ không ném", async () => {
  const r1 = await transitionIncident(memoryAdmin({ warehouse_incidents: [] }), "x", "resolve", "u", NOW);
  assert.equal(r1.ok ? 200 : r1.status, 404);
  const r2 = await transitionIncident(
    memoryAdmin({ warehouse_incidents: [incident({})] }, { failUpdate: "warehouse_incidents" }),
    "i1",
    "resolve",
    "u",
    NOW,
  );
  assert.equal(r2.ok ? 200 : r2.status, 500);
});

test("câu báo xung đột", () => {
  assert.match(conflictMessage("resolve", "resolved"), /đã được đóng/);
  assert.match(conflictMessage("acknowledge", "resolved"), /đã được đóng/);
});

test("lọc: mặc định đang mở; 'system' là sự cố không thuộc shop nào", async () => {
  assert.equal(parseStatusFilter(null), "active");
  assert.equal(parseStatusFilter("xyz"), "active");
  assert.equal(parseStatusFilter("resolved"), "resolved");
  const tables = {
    warehouse_incidents: [
      incident({ id: "a" }),
      incident({ id: "b", organization_id: null, issue_key: "cron_orphan_segments" }),
      incident({ id: "c", status: "resolved", resolved_at: "x", resolved_reason: "auto_ok" }),
      incident({ id: "d", organization_id: ORG_B, status: "acknowledged" }),
    ],
  };
  const ids = async (f: Parameters<typeof listIncidents>[1]) => {
    const r = await listIncidents(memoryAdmin(tables), f);
    return r.ok ? r.rows.map((x) => x.id).sort() : [];
  };
  assert.deepEqual(await ids({ status: "active", orgId: null }), ["a", "b", "d"]);
  assert.deepEqual(await ids({ status: "active", orgId: "system" }), ["b"]);
  assert.deepEqual(await ids({ status: "all", orgId: ORG_A }), ["a", "c"]);
  assert.deepEqual(await ids({ status: "resolved", orgId: null }), ["c"]);
});

test("route sự cố: support trở lên, kiểm action, audit gắn vào tổ chức", () => {
  const src = readFileSync("src/app/api/platform/incidents/[id]/route.ts", "utf8");
  assert.ok(src.includes('requirePlatformRole("platform_support")'));
  assert.ok(src.includes("INCIDENT_ACTIONS.includes("), "action lạ phải bị 400");
  assert.ok(src.includes("action: `platform.incident.${action}`"));
  const list = readFileSync("src/app/api/platform/incidents/route.ts", "utf8");
  assert.ok(list.includes("lastBackgroundRun"), "trang phải biết con tự kiểm còn sống không");
  assert.ok(!list.includes("syncIncidents("), "mở trang không được ghi sổ");
});

test("thời lượng sự cố", () => {
  const from = "2026-09-26T08:00:00Z";
  assert.equal(spanLabel(from, "2026-09-26T08:45:00Z"), "45 phút");
  assert.equal(spanLabel(from, "2026-09-26T11:15:00Z"), "3 giờ 15 phút");
  assert.equal(spanLabel(from, "2026-09-29T10:00:00Z"), "3 ngày 2 giờ");
  assert.equal(spanLabel(from, "2026-09-26T07:00:00Z"), "0 phút", "mốc ngược không ra số âm");
  // "đã đóng thì tính tới lúc đóng" — kiểm ở bài dựng giao diện.
});

test("lưới cấu hình: dòng 'cần chú ý' khi có ô không phải Đặt hoặc có hệ quả", () => {
  const p = (source: EffectiveParam["source"], consequence: string | null = null): EffectiveParam => ({
    key: "k", label: "k", unit: "giây", set: 1, effective: 1, source, reason: null, consequence,
  });
  assert.equal(needsAttention([p("set"), p("set")]), false);
  assert.equal(needsAttention([p("set"), p("default")]), true);
  assert.equal(needsAttention([p("set", "clip cụt")]), true);
});

test("menu platform có hai mục mới", () => {
  const nav = readFileSync("src/lib/platform-nav.ts", "utf8");
  assert.ok(nav.includes('href: "/platform/incidents"'));
  assert.ok(nav.includes('href: "/platform/config"'));
});
