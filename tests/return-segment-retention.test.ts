import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRetentionPlan } from "../warehouse-agent/src/retention-plan.ts";

/**
 * Đợt 4 hàng hoàn: segment chỉ phục vụ bàn NHẬN HOÀN giữ 7 ngày thay vì
 * hạn chung của tổ chức.
 *
 * Thứ đáng sợ ở đây không phải bug làm hệ thống đứng, mà bug làm XOÁ SỚM
 * bằng chứng đơn đi — sẽ không ai phát hiện cho tới lúc cần video và nó
 * không còn. Nên các test dưới đây canh đúng một thứ: mọi nhánh nghi ngờ
 * đều phải nghiêng về GIỮ.
 */

// ---------------------------------------------------------------------------
// Phân loại (SQL): ba điều kiện, thiếu một là không đánh dấu.
// ---------------------------------------------------------------------------

test("hàm phân loại giữ đủ ba điều kiện an toàn", () => {
  const sql = readFileSync(
    "supabase/migrations/20260921120000_return_segment_retention.sql",
    "utf8",
  );

  // (a) trọn trong một kỳ NHẬN HOÀN.
  assert.ok(sql.includes("smp.started_at <= c.started_at"), "thiếu vế bọc đầu kỳ hoàn");
  assert.ok(
    sql.includes("COALESCE(smp.ended_at, 'infinity'::timestamptz) >= c.ended_at"),
    "thiếu vế bọc cuối kỳ hoàn — kỳ đang mở phải tính là chưa bọc hết",
  );
  // (b) không đụng cửa sổ video của đơn đi nào.
  assert.ok(sql.includes("pe.event_kind = 'outbound'"), "thiếu vế loại trừ đơn đi");
  assert.ok(sql.includes("NOT EXISTS"), "vế đơn đi phải là NOT EXISTS, không phải JOIN");
  // (c) camera chỉ phục vụ đúng một bàn trong khoảng đó.
  assert.ok(
    sql.includes("HAVING count(DISTINCT station_id) = 1"),
    "camera phục vụ hai bàn thì không được đánh dấu",
  );
  // Segment đang ghi chưa biết chứa gì.
  assert.ok(sql.includes("f.ended_at IS NOT NULL"), "segment chưa đóng phải bị loại");

  // Chỉ có đúng một giá trị rút hạn; thêm giá trị mới là đổi chính sách.
  assert.ok(sql.includes("CHECK (retention_class IN ('default', 'return_short'))"));
});

test("phân loại chỉ nâng cấp một chiều default → return_short", () => {
  const sql = readFileSync(
    "supabase/migrations/20260921120000_return_segment_retention.sql",
    "utf8",
  );
  assert.ok(
    sql.includes("f.retention_class = 'default'"),
    "phải lọc theo default — chạy lại không được đụng file đã phân loại",
  );
  assert.ok(
    !sql.includes("SET retention_class = 'default'"),
    "không có đường hạ ngược lại: một khi đã đánh dấu thì giữ nguyên",
  );
});

// ---------------------------------------------------------------------------
// Route cloud: phân loại rồi trả danh sách, có trần.
// ---------------------------------------------------------------------------

test("route danh sách hàng hoàn có ký HMAC, phân loại và chặn trần", () => {
  const source = readFileSync("src/app/api/agent/retention-plan/route.ts", "utf8");
  assert.ok(source.includes("verifyAgentRequest"), "route agent phải xác thực HMAC");
  assert.ok(source.includes("classify_return_segments"), "phải phân loại trước khi trả");
  assert.ok(source.includes("return_segment_retention_days"), "phải đọc số ngày từ cấu hình kho");
  assert.ok(source.includes('.eq("retention_class", "return_short")'), "chỉ trả file đã đánh dấu");
  assert.ok(source.includes("MAX_FILES"), "phải có trần số file mỗi lượt");

  // Bản ghi segment không bị xoá khi agent xoá file, nên danh sách xếp từ
  // cũ nhất sẽ dần toàn file đã xoá và chiếm hết trần — file mới quá hạn
  // không lọt vào, cleanup âm thầm ngừng tác dụng.
  assert.ok(
    source.includes("windowStart") && source.includes('.gt("started_at", windowStart)'),
    "danh sách phải có cận dưới, nếu không trần 5000 sẽ bị file cũ chiếm hết",
  );
});

// ---------------------------------------------------------------------------
// Agent: ghi cache đúng hình dạng script đọc được.
// ---------------------------------------------------------------------------

test("agent ghi retention-plan.json đúng hình dạng script cần", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "retention-plan-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await writeRetentionPlan({
      returnRetentionDays: 7,
      files: ["dahua_3/2026/09/21/seg-001.mp4"],
    });
    const parsed = JSON.parse(read(path.join(dir, "retention-plan.json"), "utf8"));
    assert.equal(parsed.return_retention_days, 7);
    assert.deepEqual(parsed.files, ["dahua_3/2026/09/21/seg-001.mp4"]);
    assert.ok(typeof parsed.updated_at === "string" && parsed.updated_at.length > 0);
  } finally {
    process.chdir(cwd);
  }
});

test("agent hỏi danh sách lúc boot và theo nhịp, dừng timer khi tắt", () => {
  const source = readFileSync("warehouse-agent/src/index.ts", "utf8");
  assert.ok(source.includes("refreshRetentionPlan"), "thiếu lượt gọi danh sách");
  assert.ok(
    source.includes("swallow(refreshPlan(), \"refreshRetentionPlan\")"),
    "phải gọi một lần lúc boot — máy mới cài không nên chờ tới nhịp sau",
  );
  assert.ok(source.includes("clearInterval(retentionPlanTimer)"), "timer phải được dọn khi tắt");
});

test("clip hoàn hết hạn báo 'quá hạn', không báo mất file", () => {
  const source = readFileSync("warehouse-agent/src/index.ts", "utf8");
  const block = source.slice(
    source.indexOf("const plan = await readRetentionPlan()"),
    source.indexOf("segments_missing_on_disk clip="),
  );
  assert.ok(block.length > 0, "không tìm thấy nhánh phân biệt quá hạn hàng hoàn");
  assert.ok(
    block.includes("allMissingArePlanned") && block.includes("olderThanReturnLimit"),
    "chỉ được coi là quá hạn khi MỌI file thiếu đều nằm trong danh sách VÀ đã đủ ngày",
  );
  assert.ok(
    block.includes("clip_expired_retention"),
    "phải dùng đúng mã lý do nghiệp vụ, không đẩy báo động ổ hỏng",
  );
});

// ---------------------------------------------------------------------------
// Script dọn ổ đĩa: hai nhóm, hai kiểu fail — và không bao giờ xoá rộng hơn.
// ---------------------------------------------------------------------------

test("script cleanup fail-safe với danh sách hàng hoàn, fail-loud với hạn chung", () => {
  const ps1 = readFileSync("warehouse-agent/scripts/cleanup-segments.ps1", "utf8");

  // Hạn chung: thiếu cache là dừng hẳn (exit 2).
  assert.ok(
    ps1.includes("retention-cache.json không tìm thấy") && ps1.includes("exit 2"),
    "thiếu retention-cache.json vẫn phải dừng hẳn",
  );

  // Hàng hoàn: thiếu hoặc hỏng thì bỏ qua bước đó, KHÔNG dừng script.
  const planBlock = ps1.slice(ps1.indexOf("$returnPlanPath"), ps1.indexOf("$cameraDirs"));
  assert.ok(planBlock.length > 0, "không tìm thấy khối xử lý retention-plan.json");
  assert.ok(
    !planBlock.includes("exit 2"),
    "danh sách hàng hoàn thiếu/hỏng chỉ được bỏ qua, không được dừng cleanup",
  );
  assert.ok(planBlock.includes("Bỏ qua bước xoá sớm segment hàng hoàn"));

  // Guard: không đụng file đang ghi, không đụng thư mục hôm nay.
  assert.ok(planBlock.includes("$recentGuard"), "thiếu guard file đang ghi");
  assert.ok(planBlock.includes("$todayFolder"), "thiếu guard thư mục hôm nay");
  assert.ok(planBlock.includes("$returnCutoff"), "thiếu vế kiểm tra đã đủ 7 ngày");

  // Danh sách đến từ mạng: không cho trỏ ra ngoài thư mục ghi hình.
  assert.ok(
    planBlock.includes("StartsWith($recordingFull"),
    "phải chặn đường dẫn nằm ngoài RECORDING_DIR",
  );
});

test("lịch dọn ổ đĩa chạy hàng ngày ở cả file mẫu lẫn installer", () => {
  const xml = readFileSync("warehouse-agent/scripts/cleanup-task.xml", "utf8");
  assert.ok(xml.includes("<ScheduleByDay>"), "task mẫu phải là lịch ngày");
  assert.ok(!xml.includes("ScheduleByWeek"), "còn sót lịch tuần");

  // Installer sinh XML riêng — hai nơi lệch nhau thì máy mới cài vẫn chạy
  // lịch tuần, và segment hàng hoàn nằm lại thêm 6 ngày mà không ai biết.
  const iss = readFileSync("warehouse-agent/installer/betacom-agent.iss", "utf8");
  assert.ok(iss.includes("<ScheduleByDay>"), "installer phải sinh lịch ngày");
  assert.ok(!iss.includes("ScheduleByWeek"), "installer còn sót lịch tuần");
});
