import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./read-source";
import { CHECK_CONFIG, CHECK_KEYS, collectConfigProblems } from "@/lib/system/checks";
import { ORDER_HARD_LIMIT_SECONDS } from "@/lib/station/order-timeout";
import { CHECK_LABELS } from "@/lib/system/check-labels";

/**
 * Mục kiểm "Cấu hình" — điểm mù cuối cùng của bộ theo dõi.
 *
 * Mười mục còn lại đều hỏi "hệ thống có đang chạy không". Không mục nào hỏi
 * "kho này cấu hình đủ chưa, và giá trị đặt có thật sự được dùng không".
 * Ba kiểu hỏng ở đây đều IM LẶNG: hệ thống chạy bình thường, số liệu vẫn ra,
 * chỉ là không đúng ý người đặt.
 *
 * Đo trên production 25/09/2026, và đây là dữ liệu dùng cho các bài dưới:
 *   - `return_retention_days` của CẢ HAI tổ chức đều NULL → đang chạy mặc
 *     định 7 ngày mà không ai đặt.
 *   - Kho Betacom Demo đặt `max_order_seconds = 600`, tầng video kéo về 180.
 */

const cfg = CHECK_CONFIG.config;
const org = (retention: number | null, ret: number | null) => ({
  id: "org-1",
  retention_days: retention,
  return_retention_days: ret,
});
const kho = (code: string, maxOrderSeconds?: number) => ({
  id: `wh-${code}`,
  code,
  organization_id: "org-1",
  packing_timing_config: maxOrderSeconds === undefined ? null : { max_order_seconds: maxOrderSeconds },
  session_fallback_seconds: 30,
});
const may = (code: string, drift: number | null) => ({
  code,
  organization_id: "org-1",
  time_drift_seconds: drift,
});

test("cấu hình đủ và không bị kẹp thì im lặng", () => {
  // Im lặng là bình thường — nguyên tắc của cả module. Mục này mà kêu lúc
  // mọi thứ ổn thì người trực sẽ tắt thông báo, và lần thật không ai đọc.
  const problems = collectConfigProblems({
    org: org(30, 7),
    warehouses: [kho("BKDK", 180)],
    agents: [may("AGENT_01", 0)],
    cfg,
  });
  assert.deepEqual(problems, []);
});

test("thiếu thời gian lưu video là CRIT, không phải warn", () => {
  // Hạn lưu NULL thì agent không ghi cache, script dọn ổ máy kho fail-loud
  // rồi KHÔNG chạy. Ổ đầy dần tới lúc hỏng ghi hình — mất bằng chứng thật.
  const problems = collectConfigProblems({
    org: org(null, 7),
    warehouses: [],
    agents: [],
    cfg,
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].status, "crit");
  assert.match(problems[0].detail, /script dọn ổ đĩa sẽ không chạy/);
});

test("thiếu hạn lưu hàng hoàn là warn, và nói rõ đang chạy bằng gì", () => {
  // Khác ca trên: rơi về mặc định 7 ngày nên vẫn chạy, chỉ là không ai
  // quản. Câu thông báo phải nói CON SỐ đang chạy, không chỉ "chưa đặt" —
  // không thì người đọc không biết hệ thống đang làm gì.
  const problems = collectConfigProblems({
    org: org(30, null),
    warehouses: [],
    agents: [],
    cfg,
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].status, "warn");
  assert.match(problems[0].detail, /mặc định 7 ngày/);
});

test("giá trị bị kẹp: đặt 600 nhưng chỉ chạy tới 180", () => {
  // Đúng kho Betacom Demo. Mã nguồn có console.warn nhưng không ai đọc log
  // máy chủ, nên trước mục này thì không có cách nào biết.
  const problems = collectConfigProblems({
    org: org(30, 7),
    warehouses: [kho("KHO_HN", 600)],
    agents: [],
    cfg,
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].status, "warn");
  assert.match(problems[0].detail, /600s/);
  assert.match(problems[0].detail, new RegExp(`${ORDER_HARD_LIMIT_SECONDS}s`));
});

test("đặt đúng bằng trần thì KHÔNG kêu", () => {
  // Ranh giới: 180 không bị kẹp, 181 mới bị. Sai dấu so sánh ở đây là mọi
  // kho đặt đúng chuẩn đều bị báo nhầm.
  assert.deepEqual(
    collectConfigProblems({ org: org(30, 7), warehouses: [kho("A", ORDER_HARD_LIMIT_SECONDS)], agents: [], cfg }),
    [],
  );
  assert.equal(
    collectConfigProblems({ org: org(30, 7), warehouses: [kho("A", ORDER_HARD_LIMIT_SECONDS + 1)], agents: [], cfg })
      .length,
    1,
  );
});

test("luật 'hạn lưu thấp hơn sàn ổ đĩa' đã gỡ vì database chặn trước", () => {
  // Bản đợt 1 có luật này, nhưng nó KHÔNG BAO GIỜ chạy được: ràng buộc
  // CHECK trên database chặn retention_days ngoài 7–365. Mã chết đánh lừa
  // người đọc sau, nên gỡ. Bài này canh cả hai phía: ai gỡ ràng buộc CHECK
  // thì phải thêm lại luật, vì lúc đó mâu thuẫn mới có thật.
  const mig = readSource("supabase/migrations/20260722120000_organizations_retention_days.sql");
  assert.ok(
    mig.includes("CHECK (retention_days IS NULL OR (retention_days >= 7 AND retention_days <= 365))"),
    "ràng buộc CHECK đổi rồi — hạn lưu dưới 7 ngày giờ có thể xảy ra, phải thêm lại luật",
  );
  // Soi đúng dấu vết của luật chứ không soi chữ: ghi chú giải thích vì sao
  // gỡ vẫn được phép nhắc tới nó.
  const src = readSource("src/lib/system/checks.ts");
  assert.ok(!src.includes("minRetentionDays"), "ngưỡng của luật chết vẫn còn trong cấu hình");
  assert.ok(!src.includes("org.retention_days < "), "phép so của luật chết vẫn còn trong mã");
});

test("lệch giờ máy kho: warn từ 5 giây, crit từ 30 giây", () => {
  const doLech = (n: number | null) =>
    collectConfigProblems({ org: org(30, 7), warehouses: [], agents: [may("AGENT_01", n)], cfg });

  assert.deepEqual(doLech(0), [], "0 giây thì không kêu");
  assert.deepEqual(doLech(cfg.driftWarnSeconds - 1), [], "dưới ngưỡng warn thì không kêu");
  assert.equal(doLech(cfg.driftWarnSeconds)[0].status, "warn");
  assert.equal(doLech(cfg.driftCritSeconds)[0].status, "crit");
  assert.deepEqual(doLech(null), [], "chưa đo được thì không đoán bừa");
});

test("mọi vấn đề đều phải kèm câu CẦN LÀM", () => {
  // Luật của module: thêm mã lỗi mà không viết được việc cần làm thì không
  // được thêm. Gộp triệu chứng và việc cần làm vào một câu thì người trực
  // phải tự suy ra bước tiếp theo.
  const problems = collectConfigProblems({
    org: org(null, null),
    warehouses: [kho("A", 600)],
    agents: [may("AGENT_01", 60)],
    cfg,
  });
  assert.equal(problems.length, 4, "bốn luật, bốn vấn đề");
  for (const p of problems) {
    assert.ok(p.action && p.action.length > 10, `thiếu câu cần làm: ${p.detail}`);
    assert.notEqual(p.action, p.detail, "việc cần làm phải tách khỏi triệu chứng");
  }
});

test("mục được đăng ký vào bộ kiểm và có nhãn trên trang", () => {
  // Viết hàm mà quên cắm vào runSystemChecks là mục không bao giờ chạy —
  // đúng kiểu lỗi im lặng mà chính mục này sinh ra để bắt.
  const src = readSource("src/lib/system/checks.ts");
  assert.ok(
    src.includes("needAdmin(CHECK_KEYS.config, (a) => checkConfiguration(a, now, scope ?? undefined))"),
    "chưa đăng ký vào runSystemChecks",
  );
  assert.ok(src.includes("      config,\n    ],"), "chưa đưa vào danh sách checks trả về");

  assert.equal(CHECK_LABELS[CHECK_KEYS.config], "Cấu hình", "chưa có nhãn tiếng Việt — trang sẽ hiện mã khoá thô");
});

test("MỌI mục kiểm đều có nhãn tiếng Việt dùng chung cho trang Tình trạng và trang Sự cố", () => {
  const missing = Object.values(CHECK_KEYS).filter((k) => !CHECK_LABELS[k]);
  assert.deepEqual(missing, [], "thiếu nhãn — trang sẽ hiện mã khoá thô");
});
