import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveOrgParams, resolveWarehouseParams } from "@/lib/config/effective";
import { resolveReturnRetentionDays } from "@/lib/config/return-retention";
import {
  FALLBACK_BEFORE_NEXT,
  FALLBACK_DEFAULT_POST,
  FALLBACK_PRE,
  readTimingConfig,
} from "@/lib/order-proof/timing-config";
import { readdirSync } from "node:fs";
import { resolveOrderLimitSeconds, resolveReturnLimitSeconds } from "@/lib/station/order-timeout";

/**
 * Phép giải "Đặt / Thực dùng" (đợt 2, 26/09/2026).
 *
 * Nguyên tắc duy nhất của phép giải: KHÔNG TỰ TÍNH. Con số "thực dùng" phải
 * đến từ đúng hàm mà hệ thống chạy thật đang gọi. Các bài dưới canh đúng
 * nguyên tắc đó bằng cách so trực tiếp với các hàm ấy trên nhiều cấu hình —
 * ai lỡ chép logic kẹp vào phép giải rồi để lệch là đỏ ngay.
 */

const find = (params: ReturnType<typeof resolveWarehouseParams>, key: string) => {
  const p = params.find((x) => x.key === key);
  assert.ok(p, `thiếu thông số ${key}`);
  return p;
};

const CONFIGS: unknown[] = [
  null,
  {},
  { max_order_seconds: 180, video_pre_seconds: 5, video_before_next_seconds: 2, video_default_post_seconds: 60 },
  { max_order_seconds: 600, video_pre_seconds: 10 }, // đúng kho Betacom Demo
  { max_order_seconds: 10, video_pre_seconds: 300, video_default_post_seconds: 900 },
  { max_order_seconds: 0, video_pre_seconds: -1, video_before_next_seconds: 0, video_default_post_seconds: 0 },
  { max_order_seconds: "abc", return_max_seconds: 30 },
  { return_max_seconds: 600 },
  { return_max_seconds: -5, video_before_next_seconds: 90 },
];

test("thực dùng = đúng giá trị các hàm chạy thật trả về, trên mọi cấu hình thử", () => {
  for (const cfg of CONFIGS) {
    const params = resolveWarehouseParams({ packing_timing_config: cfg, session_fallback_seconds: 30 });
    const t = readTimingConfig(cfg);
    const label = JSON.stringify(cfg);
    assert.equal(find(params, "max_order_seconds").effective, resolveOrderLimitSeconds(cfg), label);
    assert.equal(find(params, "return_max_seconds").effective, resolveReturnLimitSeconds(cfg), label);
    assert.equal(find(params, "video_pre_seconds").effective, t.pre, label);
    assert.equal(find(params, "video_before_next_seconds").effective, t.beforeNext, label);
    assert.equal(find(params, "video_default_post_seconds").effective, t.defaultPost, label);
  }
});

test("kho Betacom Demo: đặt 600, thực dùng 180, BỊ KẸP — tiêu chí nghiệm thu đợt 2", () => {
  const p = find(
    resolveWarehouseParams({ packing_timing_config: { max_order_seconds: 600 }, session_fallback_seconds: 30 }),
    "max_order_seconds",
  );
  assert.equal(p.set, 600);
  assert.equal(p.effective, 180);
  assert.equal(p.source, "clamped");
  assert.match(p.reason ?? "", /180s/);
  assert.match(p.reason ?? "", /600s chỉ còn dùng để đánh dấu đơn bất thường/);
});

test("đặt đúng như chạy thì không có lý do — im lặng là bình thường", () => {
  const params = resolveWarehouseParams({
    packing_timing_config: {
      max_order_seconds: 180,
      video_pre_seconds: 5,
      video_before_next_seconds: 2,
      video_default_post_seconds: 60,
      return_max_seconds: 150,
    },
    session_fallback_seconds: 30,
  });
  for (const p of params) {
    assert.equal(p.source, "set", `${p.key} phải là "set"`);
    assert.equal(p.reason, null, `${p.key} không được có lý do khi đặt đúng`);
  }
});

test("ô để trống là MẶC ĐỊNH, và nói rõ con số đang chạy", () => {
  const p = find(resolveWarehouseParams({ packing_timing_config: {}, session_fallback_seconds: null }), "video_pre_seconds");
  assert.equal(p.set, null);
  assert.equal(p.source, "default");
  assert.equal(p.effective, readTimingConfig({}).pre);
  assert.match(p.reason ?? "", /mặc định 5s/);
});

test("undefined là ô TRỐNG, không phải 'đặt giá trị ngoài khoảng'", () => {
  // Lỗi bắt được lúc viết đợt 2: bản ghi thiếu trường (cột không select,
  // dữ liệu giả) cho ra undefined, và phép giải đọc nhầm thành "đã đặt
  // nhưng sai" → báo BỊ KẸP. Database thật trả null nên chưa lộ, nhưng
  // phép giải không được giòn như vậy.
  const params = resolveOrgParams({} as never);
  assert.equal(params.find((p) => p.key === "retention_days")?.source, "disabled");
  assert.equal(params.find((p) => p.key === "return_retention_days")?.source, "default");
  const wh = resolveWarehouseParams({ packing_timing_config: {} } as never);
  assert.equal(find(wh, "session_fallback_seconds").source, "default");
});

test("thiếu hạn lưu video là KHÔNG CHẠY, không phải mặc định", () => {
  // Hạn lưu không có mặc định: trống là agent không nhận được, script dọn
  // ổ máy kho không chạy. Gọi nó là "mặc định" là nói dối.
  const p = resolveOrgParams({ retention_days: null, return_retention_days: 7 }).find(
    (x) => x.key === "retention_days",
  );
  assert.equal(p?.source, "disabled");
  assert.equal(p?.effective, null);
});

test("kiện hoàn 300s: nói rõ phần cuối không có video", () => {
  // Đo trên production 26/09/2026: kiện hoàn làm 300s ra clip đúng 180s,
  // lý do capped_at_max_duration. Với đệm 5s thì clip phủ 175s đầu.
  const p = find(
    resolveWarehouseParams({ packing_timing_config: { video_pre_seconds: 5 }, session_fallback_seconds: 30 }),
    "return_max_seconds",
  );
  assert.equal(p.effective, 300);
  assert.match(p.consequence ?? "", /175s đầu/);
  assert.match(p.consequence ?? "", /125s cuối không có video/);
});

test("đơn đi hụt vài giây cuối thì KHÔNG làm ồn", () => {
  // 180s trần trừ đệm 5s còn 175s — hụt 5s, dưới ngưỡng đáng nói.
  const p = find(
    resolveWarehouseParams({ packing_timing_config: { video_pre_seconds: 5 }, session_fallback_seconds: 30 }),
    "max_order_seconds",
  );
  assert.equal(p.consequence, null);
});

test("hạn lưu hàng hoàn: hàm dùng chung khớp từng nhánh với phép tính cũ của route", () => {
  // Bản sao nguyên văn phép tính trong route retention-plan trước 26/09.
  const cu = (orgValue: unknown, cfg: Record<string, unknown> | null) => {
    const orgDays = Number(orgValue);
    const rawDays = Number.isFinite(orgDays) && orgDays > 0 ? orgDays : Number(cfg?.return_segment_retention_days);
    return Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.floor(rawDays) : 7;
  };
  const orgValues = [null, undefined, 0, 0.5, 1, 7, 10.9, 365, 366, -3, "12", "abc"];
  const cfgs = [null, {}, { return_segment_retention_days: 10 }, { return_segment_retention_days: 400 }, { return_segment_retention_days: "5" }];
  for (const o of orgValues) {
    for (const c of cfgs) {
      assert.equal(resolveReturnRetentionDays(o, c).days, cu(o, c), `org=${String(o)} cfg=${JSON.stringify(c)}`);
    }
  }
});

test("chỉ còn MỘT nơi đọc cấu hình thời gian clip", () => {
  // Trước 26/09/2026 bộ ước lượng dung lượng tự đọc lại video_pre_seconds,
  // cùng mặc định nhưng KHÔNG kẹp trần như máy cắt clip.
  const resolver = readFileSync("src/lib/order-proof/clip-resolver.ts", "utf8");
  const sizeRisk = readFileSync("src/lib/order-proof/proof-size-risk.ts", "utf8");
  assert.ok(!resolver.includes("function readTimingConfig"), "clip-resolver còn bản đọc riêng");
  assert.ok(resolver.includes('from "@/lib/order-proof/timing-config"'));
  assert.ok(!sizeRisk.includes("cfg?.video_pre_seconds"), "proof-size-risk còn tự đọc");
  assert.ok(sizeRisk.includes("readTimingConfig("));
});

test("phép giải không tự chép logic kẹp — phải import từ nơi chạy thật", () => {
  const src = readFileSync("src/lib/config/effective.ts", "utf8");
  for (const fn of ["readTimingConfig", "resolveOrderLimitSeconds", "resolveReturnLimitSeconds", "resolveReturnRetentionDays"]) {
    assert.ok(src.includes(`${fn}(`), `phép giải phải gọi ${fn}, không tự tính`);
  }
});

test("canh trần chung của clip-resolver — đổi nó thì phải đổi câu hệ quả", () => {
  // Phép giải nói "clip kiện hoàn chỉ phủ (180 − đệm) giây" vì clip-resolver
  // áp trần CHUNG MAX_CLIP_DURATION_SECONDS cho MỌI loại lượt, đè lên trần
  // 310s riêng của kiện hoàn. Ai sửa trần đó theo loại lượt (tức là sửa lỗi
  // cụt clip kiện hoàn) thì câu hệ quả trong effective.ts thành sai — bài này
  // đỏ để nhắc sửa luôn.
  const resolver = readFileSync("src/lib/order-proof/clip-resolver.ts", "utf8");
  assert.ok(
    resolver.includes("const maxClipEndMs = clipStart.getTime() + MAX_CLIP_DURATION_SECONDS * 1000;"),
    "trần chung trong clip-resolver đã đổi — cập nhật câu hệ quả `return_max_seconds` trong src/lib/config/effective.ts",
  );
});

test("trang platform hiện hai cột và dùng đúng phép giải", () => {
  const api = readFileSync("src/app/api/platform/orgs/[id]/route.ts", "utf8");
  assert.ok(api.includes("resolveOrgParams(") && api.includes("resolveWarehouseParams("));
  assert.ok(api.includes("return_retention_days"), "phải đọc cột hạn lưu hàng hoàn thì mới giải được");
  // Bảng tách ra thành phần riêng (26/09/2026) để dựng và kiểm riêng được —
  // Next.js không cho file trang xuất thêm thành phần. Canh cả hai đầu: bảng
  // có hai cột, VÀ trang thật sự dùng bảng đó cho tab Cấu hình.
  const panel = readFileSync("src/components/platform/ConfigParamsPanel.tsx", "utf8");
  assert.ok(panel.includes(">Đặt</th>") && panel.includes(">Thực dùng</th>"), "thiếu hai cột");
  assert.ok(panel.includes("p.consequence"), "phải hiện hệ quả, không chỉ lý do");
  const page = readFileSync("src/app/platform/orgs/[id]/page.tsx", "utf8");
  assert.ok(
    page.includes('{tab === "config" && <ConfigParamsPanel config={data.config} />}'),
    "tab Cấu hình phải dùng ConfigParamsPanel",
  );
});

test("mặc định của máy cắt clip BẰNG mặc định của database, từng khoá", () => {
  // Trước 26/09/2026: database 5s, máy cắt clip 10s. Kho lưu thiếu khoá thì
  // hai nơi hiểu khác nhau, và form sửa kho còn lưu luôn số 10 vào. Chủ dự
  // án chốt đồng bộ. Bài này đọc định nghĩa MỚI NHẤT của
  // packing_timing_default_config() — thêm migration định nghĩa lại hàm đó
  // mà quên sửa hằng số là đỏ.
  const files = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      /CREATE OR REPLACE FUNCTION public\.packing_timing_default_config/i.test(
        readFileSync(`supabase/migrations/${f}`, "utf8"),
      ),
    );
  assert.ok(files.length > 0, "không tìm thấy định nghĩa packing_timing_default_config");
  const sql = readFileSync(`supabase/migrations/${files[files.length - 1]}`, "utf8");
  const sqlDefault = (key: string) => {
    const m = sql.match(new RegExp(`'${key}',\\s*(\\d+)`));
    assert.ok(m, `migration không có khoá ${key}`);
    return Number(m[1]);
  };
  assert.equal(FALLBACK_PRE, sqlDefault("video_pre_seconds"), "video_pre_seconds lệch database");
  assert.equal(FALLBACK_BEFORE_NEXT, sqlDefault("video_before_next_seconds"), "video_before_next_seconds lệch database");
  assert.equal(FALLBACK_DEFAULT_POST, sqlDefault("video_default_post_seconds"), "video_default_post_seconds lệch database");
});

test("form sửa kho hiện đúng mặc định chung, không ghi cứng số", () => {
  // Form gửi thẳng giá trị ô lên khi Lưu. Ô trống mà hiện số sai là bấm Lưu
  // sẽ ghi số sai vào kho — âm thầm đổi cấu hình của kho đó.
  const form = readFileSync("src/app/dashboard/warehouses/page.tsx", "utf8");
  assert.ok(form.includes("video_pre_seconds ?? FALLBACK_PRE"), "form phải dùng hằng số chung");
  assert.ok(!form.includes("video_pre_seconds ?? 10"), "còn số 10 ghi cứng");
});
