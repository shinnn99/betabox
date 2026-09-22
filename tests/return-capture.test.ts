import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  planRecordingFileWrites,
  type IncomingRecordingFile,
} from "../src/lib/warehouse/recording-files-batch.ts";

/**
 * Đợt 5 hàng hoàn: phiên ghi theo tín hiệu module.
 *
 * Camera vẫn ghi liên tục cho đơn đi; tín hiệu module quyết định đoạn video
 * nào THUỘC VỀ luồng hoàn. Hai thứ phải đúng tuyệt đối:
 *   1. Không có tín hiệu → không nhãn → không đoạn nào bị rút hạn lưu.
 *   2. Nhãn đã gán thì không được một bản báo sau xoá mất.
 */

const ORG = "00000000-0000-0000-0000-000000000001";
const AGENT = "00000000-0000-0000-0000-0000000000a1";
const CAM = "11111111-1111-4111-8111-111111111111";
const CAPTURE = "22222222-2222-4222-8222-222222222222";

function file(over: Partial<IncomingRecordingFile> = {}): IncomingRecordingFile {
  return {
    camera_id: CAM,
    session_id: null,
    file_path: "cam/2026/09/21/seg-001.mp4",
    file_name: "seg-001.mp4",
    started_at: "2026-09-21T02:00:00.000Z",
    ended_at: null,
    duration_seconds: null,
    file_size_bytes: null,
    ...over,
  };
}

function plan(files: IncomingRecordingFile[], existing: Parameters<typeof planRecordingFileWrites>[0]["existing"] = []) {
  return planRecordingFileWrites({
    organizationId: ORG,
    agentId: AGENT,
    files,
    allowedCameraIds: new Set([CAM]),
    existing,
  });
}

// ---------------------------------------------------------------------------
// Nhãn phiên: chỉ đi lên, không bao giờ mất.
// ---------------------------------------------------------------------------

test("không có nhãn thì ghi null — cloud không tự đoán thay agent", () => {
  const { rows } = plan([file()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].return_capture_id, null);
});

test("agent gửi nhãn thì nhãn được ghi", () => {
  const { rows } = plan([file({ return_capture_id: CAPTURE })]);
  assert.equal(rows[0].return_capture_id, CAPTURE);
});

test("bản báo sau KHÔNG xoá nhãn đã có trong DB", () => {
  // Lượt quét lại ổ đĩa sau khi agent khởi động lại không mang nhãn. Ghi đè
  // bằng null lúc đó là mất luôn dấu vết đoạn nào thuộc hàng hoàn.
  const { rows } = plan(
    [file({ ended_at: "2026-09-21T02:01:00.000Z" })],
    [{ camera_id: CAM, file_path: "cam/2026/09/21/seg-001.mp4", ended_at: null, return_capture_id: CAPTURE }],
  );
  assert.equal(rows[0].return_capture_id, CAPTURE);
});

test("trong cùng một lô, bản có nhãn thắng bản không nhãn", () => {
  const { rows } = plan([
    file({ return_capture_id: CAPTURE }),
    file({ ended_at: "2026-09-21T02:01:00.000Z" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].return_capture_id, CAPTURE, "đoạn đóng lại mất nhãn là mất bằng chứng");
  assert.equal(rows[0].ended_at, "2026-09-21T02:01:00.000Z", "vẫn phải là bản đã đóng");
});

// ---------------------------------------------------------------------------
// Canh giữ các đường nối trong SQL và trong agent.
// ---------------------------------------------------------------------------

test("phân loại hạn lưu đòi nhãn của agent, không suy từ thời gian", () => {
  const sql = readFileSync(
    "supabase/migrations/20260921130000_return_capture_sessions.sql",
    "utf8",
  );
  assert.ok(
    sql.includes("AND f.return_capture_id IS NOT NULL"),
    "không có nhãn thì không được rút hạn lưu — đây là chốt của chủ dự án",
  );
  // Hai vế an toàn của đợt 4 phải còn nguyên.
  assert.ok(sql.includes("pe.event_kind = 'outbound'"), "mất vế loại trừ đơn đi");
  assert.ok(sql.includes("HAVING count(DISTINCT station_id) = 1"), "mất vế một bàn một camera");
});

test("mọi đường đóng kỳ đều chuyển phiên sang rút — bằng trigger, không sửa tay từng chỗ", () => {
  const sql = readFileSync(
    "supabase/migrations/20260921130000_return_capture_sessions.sql",
    "utf8",
  );
  assert.ok(sql.includes("station_mode_periods_drain_capture"), "thiếu trigger rút phiên");
  assert.ok(
    sql.includes("IF OLD.agent_acked_at IS NULL THEN"),
    "agent chưa nhận tín hiệu thì không có gì để chờ — phải đóng luôn",
  );
});

test("phiên có lối ra tự động khi trình duyệt sập và khi agent im", () => {
  const sql = readFileSync(
    "supabase/migrations/20260921130000_return_capture_sessions.sql",
    "utf8",
  );
  assert.ok(sql.includes("interval '2 minutes'"), "thiếu lối ra mất nhịp 2 phút");
  assert.ok(sql.includes("interval '15 minutes'"), "thiếu lối ra agent im");
  assert.ok(sql.includes("'abandoned'"), "phiên agent im phải có trạng thái riêng");

  const heartbeat = readFileSync("src/app/api/warehouse/heartbeat/route.ts", "utf8");
  assert.ok(
    heartbeat.includes("expire_return_captures"),
    "lối ra phải có người gọi, nếu không nó chỉ là code chết",
  );
});

test("phiên nhận hoàn chỉ mở từ giao diện — thẻ QR đã ngừng dùng", () => {
  for (const f of [
    "src/app/api/warehouse/scans/route.ts",
    "src/app/api/warehouse/manual-scan/route.ts",
  ]) {
    const source = readFileSync(f, "utf8");
    assert.ok(!source.includes('holder: "card"'), `${f} không còn giữ phiên bằng thẻ`);
    assert.ok(!source.includes('p_started_by: "card"'), `${f} không gọi thẳng set_station_mode`);
  }
});

test("agent chỉ gán nhãn cho đường ghi hình đang chạy, không gán cho lượt quét lại ổ đĩa", () => {
  const source = readFileSync("warehouse-agent/src/segment-index.ts", "utf8");
  assert.ok(source.includes("private async stamp("), "thiếu chỗ gán nhãn");
  // bootRecovery gửi thẳng qua queue/sendOrQueue nên không được đi qua stamp.
  const bootStart = source.indexOf("async bootRecovery(");
  const bootEnd = source.indexOf("private async sendOrQueue(");
  assert.ok(bootStart > 0 && bootEnd > bootStart);
  assert.ok(
    !source.slice(bootStart, bootEnd).includes("this.stamp("),
    "đoạn cũ quét lại từ ổ đĩa không được mang nhãn phiên đang mở hôm nay",
  );
});

test("agent giữ nhãn cho đoạn đang ghi dở rồi mới báo xong", () => {
  const source = readFileSync("warehouse-agent/src/return-capture.ts", "utf8");
  assert.ok(source.includes("pending_cameras"), "thiếu danh sách đoạn còn dở lúc tắt");
  assert.ok(
    source.includes("if (c.draining && c.pending_cameras.includes(cameraId)) return c.capture_id"),
    "đoạn dở lúc thoát phải thuộc phiên đang rút, ưu tiên hơn phiên mới bật",
  );
  assert.ok(
    source.includes("private readonly captures = new Map<string, CaptureEntry>()"),
    "agent phải giữ được nhiều phiên cùng lúc (nhiều bàn, chuyển qua lại nhanh)",
  );
  assert.ok(source.includes("finishIfDrained"), "thiếu điều kiện kết thúc phiên");
  // Trạng thái phải sống qua một lần khởi động lại agent.
  assert.ok(source.includes("return-capture.json"), "thiếu file trạng thái");
});

test("gán nhãn TRƯỚC khi báo đoạn đã đóng", () => {
  // Báo đóng có thể kết thúc phiên; làm ngược thứ tự là chính đoạn cuối
  // cùng — đoạn quan trọng nhất — bị mất nhãn.
  const source = readFileSync("warehouse-agent/src/segment-index.ts", "utf8");
  const block = source.slice(source.indexOf("private async stamp("));
  const mapAt = block.indexOf("labelFor(");
  const noteAt = block.indexOf("noteSegmentClosed(");
  assert.ok(mapAt > 0 && noteAt > 0);
  assert.ok(mapAt < noteAt, "phải gán nhãn trước khi báo đóng");
});
