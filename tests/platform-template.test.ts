import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLIP_MAX_SAFE_SECONDS,
  TEMPLATE_BOUNDS,
  TEMPLATE_FALLBACK,
  TEMPLATE_KEYS,
  parseTemplatePatch,
  planBlankFill,
  planIsEmpty,
  templateFromRow,
} from "@/lib/config/template";
import {
  invalidateTemplateCache,
  orgFieldsForNewOrg,
  readPlatformTemplate,
  seedNewWarehouse,
} from "@/lib/config/template-store";
import {
  ORDER_HARD_LIMIT_SECONDS,
  resolveLimitSecondsFor,
  resolveOrderLimitSeconds,
} from "@/lib/station/order-timeout";
import { MAX_CLIP_DURATION_SECONDS, MAX_RETURN_CLIP_DURATION_SECONDS, computeFinalizedClipWindow } from "@/lib/order-proof/clip-window";
import { resolveWarehouseParams } from "@/lib/config/effective";
import { CHECK_CONFIG, collectConfigProblems } from "@/lib/system/checks";

/**
 * Đợt 6 — kế hoạch VAN-HANH-NHIEU-KHO: mẫu cấu hình nền tảng. Chép lúc tạo,
 * không phủ lúc đọc; riêng trần clip là lan can đọc lúc chạy.
 */

// ── Chạy migration không được đổi hành vi kho nào ──────────────────────

test("giá trị ban đầu của migration = đúng mặc định đang chạy trong mã", () => {
  const sql = readFileSync("supabase/migrations/20260926120000_platform_config_template.sql", "utf8");
  for (const key of TEMPLATE_KEYS) {
    const m = sql.match(new RegExp(`${key}\\s+integer\\s+NOT NULL DEFAULT (\\d+)`));
    assert.ok(m, `migration thiếu cột ${key}`);
    assert.equal(Number(m[1]), TEMPLATE_FALLBACK[key], `${key}: migration và mã lệch nhau`);
  }
});

test("dự phòng trong mã = hằng số đang chạy (mất bảng mẫu không đổi hành vi)", () => {
  assert.equal(TEMPLATE_FALLBACK.clip_max_seconds, MAX_CLIP_DURATION_SECONDS);
  assert.equal(TEMPLATE_FALLBACK.max_order_seconds, ORDER_HARD_LIMIT_SECONDS);
  assert.equal(MAX_CLIP_DURATION_SECONDS, ORDER_HARD_LIMIT_SECONDS, "trần clip và trần đơn đi phải bằng nhau");
});

test("khoảng của migration khớp khoảng trong mã", () => {
  const sql = readFileSync("supabase/migrations/20260926120000_platform_config_template.sql", "utf8");
  for (const key of TEMPLATE_KEYS) {
    const { min, max } = TEMPLATE_BOUNDS[key];
    if (key === "session_fallback_seconds") {
      assert.ok(sql.includes("CHECK (session_fallback_seconds > 0)"));
      continue;
    }
    assert.ok(sql.includes(`CHECK (${key} BETWEEN ${min} AND ${max})`), `${key}: CHECK lệch khoảng ${min}–${max}`);
  }
});

test(`trần clip ${CLIP_MAX_SAFE_SECONDS}s vừa ngưỡng tải lên của agent ở bitrate ghép clip, còn dư 10%`, () => {
  const composer = readFileSync("warehouse-agent/src/compose/clip-composer.ts", "utf8");
  const kbps = Number(composer.match(/"-b:v", "(\d+)k"/)?.[1]);
  const agentCfg = readFileSync("warehouse-agent/src/config.ts", "utf8");
  assert.ok(agentCfg.includes(".default(90 * 1024 * 1024)"), "ngưỡng tải lên của agent đổi — tính lại trần");
  const uploadBytes = 90 * 1024 * 1024;
  const bytesAtCeiling = (CLIP_MAX_SAFE_SECONDS * kbps * 1000) / 8;
  assert.ok(kbps > 0);
  assert.ok(bytesAtCeiling * 1.1 <= uploadBytes, `${CLIP_MAX_SAFE_SECONDS}s × ${kbps}k × 1.1 vượt 90 MiB`);
});

// ── Sửa mẫu: từ chối, không kẹp ────────────────────────────────────────

test("sửa mẫu: ngoài khoảng là TỪ CHỐI, trần clip nói rõ vì sao", () => {
  const over = parseTemplatePatch({ clip_max_seconds: 211 });
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.message, /90 MiB/);
  assert.equal(parseTemplatePatch({ retention_days: 6 }).ok, false);
  assert.equal(parseTemplatePatch({ video_pre_seconds: 5.5 }).ok, false);
  assert.equal(parseTemplatePatch({ foo: 1 }).ok, false);
  assert.deepEqual(parseTemplatePatch({ clip_max_seconds: 200, retention_days: 45, x: 1 }), {
    ok: true,
    update: { clip_max_seconds: 200, retention_days: 45 },
  });
});

test("dòng DB hỏng một ô → ô đó lấy dự phòng, ô khác giữ", () => {
  const t = templateFromRow({ retention_days: 60, clip_max_seconds: 999, video_pre_seconds: "x" });
  assert.equal(t.retention_days, 60);
  assert.equal(t.clip_max_seconds, TEMPLATE_FALLBACK.clip_max_seconds);
  assert.equal(t.video_pre_seconds, TEMPLATE_FALLBACK.video_pre_seconds);
  assert.deepEqual(templateFromRow(null), TEMPLATE_FALLBACK);
});

// ── Điền vào ô trống: không bao giờ ghi đè ô đã đặt ────────────────────

test("điền ô trống: chỉ ô trống, ô đã đặt (kể cả lệch mẫu) giữ nguyên", () => {
  const t = { ...TEMPLATE_FALLBACK, retention_days: 45, return_retention_days: 14 };
  const plan = planBlankFill(
    { retention_days: 35, return_retention_days: null },
    [
      { id: "w1", code: "KHO_HN", packing_timing_config: { max_order_seconds: 600 }, session_fallback_seconds: null },
      {
        id: "w2",
        code: "FULL",
        packing_timing_config: { max_order_seconds: 180, video_pre_seconds: 3, video_default_post_seconds: 60 },
        session_fallback_seconds: 20,
      },
    ],
    t,
  );
  assert.deepEqual(plan.org, { return_retention_days: 14 }, "35 ngày đã đặt không bị đổi thành 45");
  assert.equal(plan.warehouses.length, 1, "kho đã đủ thì không có trong kế hoạch");
  assert.deepEqual(plan.warehouses[0].timing, { video_pre_seconds: 5, video_default_post_seconds: 60 });
  assert.equal(plan.warehouses[0].session_fallback_seconds, 30);
  assert.equal(
    planIsEmpty(planBlankFill({ retention_days: 30, return_retention_days: 7 }, [], t)),
    true,
  );
});

// ── Trần clip đọc lúc chạy: mặc định không đổi gì ──────────────────────

test("trần đơn đi theo tham số; không truyền = hành vi cũ", () => {
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 600 }), 180);
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 600 }, 200), 200);
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 150 }, 200), 150);
  assert.equal(resolveOrderLimitSeconds(null, 200), 200);
  assert.equal(resolveLimitSecondsFor("outbound", { max_order_seconds: 600 }, 200), 200);
  assert.equal(resolveLimitSecondsFor("return", {}, 200), 300, "kiện hoàn KHÔNG theo trần clip đơn đi");
});

test("cửa sổ clip đơn đi theo trần truyền vào; kiện hoàn giữ trần riêng", () => {
  const base = {
    scannedAt: new Date("2026-09-26T08:00:00Z"),
    workEndedAt: "2026-09-26T08:10:00Z",
    preSeconds: 5,
    defaultPostSeconds: 60,
  };
  assert.equal(computeFinalizedClipWindow(base).windowSeconds, MAX_CLIP_DURATION_SECONDS);
  assert.equal(computeFinalizedClipWindow({ ...base, maxClipSeconds: 200 }).windowSeconds, 200);
  assert.equal(
    computeFinalizedClipWindow({ ...base, eventKind: "return", maxClipSeconds: 200 }).windowSeconds,
    MAX_RETURN_CLIP_DURATION_SECONDS,
  );
});

test("Đặt / Thực dùng hiện đúng trần đang áp, không phải hằng số", () => {
  const p = resolveWarehouseParams({ packing_timing_config: { max_order_seconds: 600 }, session_fallback_seconds: null }, 200)
    .find((x) => x.key === "max_order_seconds")!;
  assert.equal(p.effective, 200);
  assert.match(p.reason ?? "", /trần kỹ thuật 200s/);
  const q = resolveWarehouseParams({ packing_timing_config: { max_order_seconds: 190 }, session_fallback_seconds: null }, 200)
    .find((x) => x.key === "max_order_seconds")!;
  assert.equal(q.source, "set", "190 dưới trần 200 là đang dùng đúng như đặt");
});

test("mục kiểm Cấu hình dùng cùng trần — 190s không bị báo kẹp khi trần là 200", () => {
  const wh = {
    id: "w",
    organization_id: "o",
    code: "KHO_HN",
    packing_timing_config: { max_order_seconds: 190 },
    session_fallback_seconds: 30,
  };
  const args = { warehouses: [wh], agents: [], cfg: CHECK_CONFIG.config } as Parameters<typeof collectConfigProblems>[0];
  assert.equal(collectConfigProblems(args).length, 1, "trần mặc định 180: 190 bị kẹp");
  assert.equal(collectConfigProblems({ ...args, clipMaxSeconds: 200 }).length, 0);
});

test("mọi nơi dùng trần đều đọc từ mẫu", () => {
  const uses: Array<[string, string]> = [
    ["src/lib/order-proof/clip-resolver.ts", "clipStart.getTime() + clipMaxSeconds * 1000"],
    ["src/lib/order-proof/clip-resolver.ts", "maxClipSeconds: clipMaxSeconds"],
    ["src/lib/station/force-stop-expired-orders.ts", "resolveOrderLimitSeconds(cfg, orderHardLimit)"],
    ["src/app/api/live/[stationId]/events/route.ts", "await getClipMaxSeconds(access.admin)"],
    ["src/lib/order-proof/proof-size-risk.ts", "maxClipSeconds,"],
    ["src/lib/system/checks.ts", "clipMaxSeconds,\n    });"],
    ["src/app/api/platform/config/route.ts", "resolveWarehouseParams(w, clipMax)"],
    ["src/app/api/platform/orgs/[id]/route.ts", "resolveWarehouseParams(w, clipMaxSeconds)"],
  ];
  for (const [file, needle] of uses) assert.ok(readFileSync(file, "utf8").includes(needle), `${file}: ${needle}`);
});

// ── Đọc mẫu: không bao giờ ném, không bao giờ ô trống ──────────────────

function fakeAdmin(opts: { row?: Record<string, unknown> | null; error?: { code?: string; message: string } }) {
  const writes: Array<{ table: string; values: Record<string, unknown>; filters: unknown[] }> = [];
  let reads = 0;
  const admin = {
    from(table: string) {
      let values: Record<string, unknown> | null = null;
      const filters: unknown[] = [];
      const q: Record<string, unknown> = {
        select: () => q,
        update: (v: Record<string, unknown>) => ((values = v), q),
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        maybeSingle: async () => {
          reads++;
          return opts.error ? { data: null, error: opts.error } : { data: opts.row ?? null, error: null };
        },
        then: (res: (v: unknown) => void) => {
          if (values) writes.push({ table, values, filters });
          res({ error: null });
        },
      };
      return q;
    },
  };
  return { admin: admin as never, writes, reads: () => reads };
}

test("chưa có bảng mẫu → dự phòng trong mã, nói rõ migration", async () => {
  invalidateTemplateCache();
  const { admin } = fakeAdmin({ error: { code: "PGRST205", message: "not found" } });
  const r = await readPlatformTemplate(admin);
  assert.equal(r.fromTable, false);
  assert.deepEqual(r.template, TEMPLATE_FALLBACK);
  assert.match(r.reason ?? "", /20260926120000/);
  invalidateTemplateCache();
});

test("đệm 60 giây: hai lần đọc liền nhau chỉ hỏi DB một lần; fresh thì hỏi lại", async () => {
  invalidateTemplateCache();
  const f = fakeAdmin({ row: { id: 1, clip_max_seconds: 200 } });
  assert.equal((await readPlatformTemplate(f.admin)).template.clip_max_seconds, 200);
  await readPlatformTemplate(f.admin);
  assert.equal(f.reads(), 1);
  await readPlatformTemplate(f.admin, { fresh: true });
  assert.equal(f.reads(), 2);
  invalidateTemplateCache();
});

test("tổ chức mới nhận hai ô hạn lưu từ mẫu", async () => {
  invalidateTemplateCache();
  const { admin } = fakeAdmin({ row: { id: 1, retention_days: 45, return_retention_days: 14 } });
  assert.deepEqual(await orgFieldsForNewOrg(admin), { retention_days: 45, return_retention_days: 14 });
  invalidateTemplateCache();
});

test("kho mới: GỘP mẫu vào JSON mặc định của DB — giữ nguyên khoá kỹ thuật", async () => {
  invalidateTemplateCache();
  const f = fakeAdmin({ row: { id: 1, max_order_seconds: 240, video_pre_seconds: 8, session_fallback_seconds: 45 } });
  const dbDefault = { timing_strategy: "until_next_scan", max_order_seconds: 180, return_max_seconds: 300, stale_session_hours: 12 };
  const err = await seedNewWarehouse(f.admin, { id: "w9", organization_id: "o9", packing_timing_config: dbDefault });
  assert.equal(err, null);
  const w = f.writes.find((x) => x.table === "warehouses")!;
  assert.deepEqual(w.values.packing_timing_config, {
    timing_strategy: "until_next_scan",
    max_order_seconds: 240,
    return_max_seconds: 300,
    stale_session_hours: 12,
    video_pre_seconds: 8,
    video_default_post_seconds: TEMPLATE_FALLBACK.video_default_post_seconds,
  });
  assert.equal(w.values.session_fallback_seconds, 45);
  assert.deepEqual(w.filters, [["id", "w9"], ["organization_id", "o9"]]);
  invalidateTemplateCache();
});

test("ba chỗ tạo đều chép mẫu", () => {
  for (const p of ["src/app/api/platform/orgs/route.ts", "src/app/api/signup/route.ts"]) {
    assert.ok(readFileSync(p, "utf8").includes(".insert({ name: orgName, slug, ...(await orgFieldsForNewOrg(admin)) })"), p);
  }
  assert.ok(readFileSync("src/app/api/warehouses/route.ts", "utf8").includes("await seedNewWarehouse(admin, data)"));
});

test("API mẫu: owner mới sửa; điền ô trống có xem trước và audit từng tổ chức", () => {
  const t = readFileSync("src/app/api/platform/config/template/route.ts", "utf8");
  assert.ok(t.includes('requirePlatformRole("platform_owner")'));
  assert.ok(t.includes("invalidateTemplateCache()"), "sửa trần phải có hiệu lực ngay, không chờ hết đệm");
  assert.ok(t.includes('action: "platform.config_template.update"'));
  const a = readFileSync("src/app/api/platform/config/template/apply/route.ts", "utf8");
  assert.ok(a.includes('requirePlatformRole("platform_owner")'));
  assert.ok(a.includes("dryRun"));
  assert.ok(a.includes(".is(key, null)"), "cột tổ chức chỉ ghi khi vẫn trống");
  assert.ok(a.includes('action: "platform.config_template.apply"'));
});
