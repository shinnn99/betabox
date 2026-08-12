import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  DB_CHUNK_SIZE,
  planRecordingFileWrites,
  recordingFileKey,
  type ExistingRecordingFile,
  type IncomingRecordingFile,
} from "../src/lib/warehouse/recording-files-batch.ts";

/**
 * Gộp lô ghi nhận segment.
 *
 * Đo bằng pg_stat_statements 2026-08-12: vòng lặp cũ (1 SELECT +
 * 1 upsert mỗi file) chiếm 64,5% tổng lượt gọi PostgREST của cả project.
 *
 * Đổi từ vòng lặp sang bulk có ba cạnh dễ vỡ, test theo đúng ba cạnh đó:
 *   1. Luật collision với DB phải giữ nguyên từng chữ.
 *   2. Trùng NỘI BỘ lô phải bị khử — Postgres không cho ON CONFLICT
 *      chạm cùng một row hai lần ("cannot affect row a second time"),
 *      vòng lặp cũ không dính lỗi này nên nó là rủi ro MỚI.
 *   3. Chunk phải chặn dưới trần `.in()` của PostgREST bất kể agent gửi
 *      bao nhiêu (route cho tới 200 file/lô).
 */

const ORG = "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8";
const CAM = "3a5112e0-3197-4d55-badb-efc37418612e";
const CAM_KHAC = "5ce23718-0737-43bb-a1dc-7646e87c0a89";
const ALLOWED = new Set([CAM, CAM_KHAC]);

function file(
  filePath: string,
  endedAt: string | null,
  cameraId: string = CAM,
): IncomingRecordingFile {
  return {
    camera_id: cameraId,
    session_id: null,
    file_path: filePath,
    file_name: filePath.split("/").pop() ?? filePath,
    started_at: "2026-08-12T03:00:00.000Z",
    ended_at: endedAt,
    duration_seconds: endedAt === null ? null : 60,
    file_size_bytes: endedAt === null ? null : 25_000_000,
  };
}

const plan = (
  files: IncomingRecordingFile[],
  existing: ExistingRecordingFile[] = [],
) =>
  planRecordingFileWrites({
    organizationId: ORG,
    files,
    allowedCameraIds: ALLOWED,
    existing,
  });

// ---------- Ca 1: lô sạch ----------

test("lô sạch → ghi hết, không collision, không skip", () => {
  const r = plan([file("a.mp4", "2026-08-12T03:01:00Z"), file("b.mp4", null)]);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.collisions, []);
  assert.deepEqual(r.skippedOutOfOrg, []);
  assert.equal(r.rows[0].organization_id, ORG);
  assert.equal(r.rows[0].status, "ready");
  assert.equal(r.rows[0].source, "agent");
});

test("lô rỗng → không nổ, không có gì để ghi", () => {
  const r = plan([]);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.collisions, []);
  assert.deepEqual(r.skippedOutOfOrg, []);
});

test("camera ngoài org → bỏ qua, không lẫn vào collisions", () => {
  const r = plan([file("x.mp4", null, "00000000-0000-4000-8000-000000000009")]);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.skippedOutOfOrg, ["x.mp4"]);
  assert.deepEqual(r.collisions, []);
});

// ---------- Ca 2: trùng nội bộ lô (rủi ro MỚI của bulk) ----------

test("trùng nội bộ: bản đã đóng thắng bản đang mở, dù đến sau", () => {
  const r = plan([file("s.mp4", "2026-08-12T03:01:00Z"), file("s.mp4", null)]);
  assert.equal(r.rows.length, 1, "một khoá chỉ được một row");
  assert.equal(r.rows[0].ended_at, "2026-08-12T03:01:00Z");
});

test("trùng nội bộ: bản đã đóng thắng cả khi đến trước", () => {
  const r = plan([file("s.mp4", null), file("s.mp4", "2026-08-12T03:01:00Z")]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ended_at, "2026-08-12T03:01:00Z");
});

test("BẤT BIẾN: rows không bao giờ có hai khoá trùng nhau", () => {
  // Đây là điều kiện để câu ON CONFLICT không nổ "cannot affect row a
  // second time". Ném cả lô hỗn tạp vào rồi soi khoá.
  const files = [
    file("a.mp4", null),
    file("a.mp4", "2026-08-12T03:01:00Z"),
    file("a.mp4", null),
    file("b.mp4", null),
    file("b.mp4", null),
    file("a.mp4", null, CAM_KHAC), // cùng path, KHÁC camera → khoá khác
  ];
  const r = plan(files);
  const keys = r.rows.map((x) => recordingFileKey(x.camera_id, x.file_path));
  assert.equal(new Set(keys).size, keys.length, `khoá trùng: ${keys.join(", ")}`);
  assert.equal(r.rows.length, 3, "a/CAM, b/CAM, a/CAM_KHAC");
});

// ---------- Ca 3: đụng row đã có trong DB (giữ nguyên luật cũ) ----------

test("DB đã đóng + agent gửi lại bản đang mở → collision, KHÔNG ghi", () => {
  const existing: ExistingRecordingFile[] = [
    { camera_id: CAM, file_path: "s.mp4", ended_at: "2026-08-12T02:00:00Z" },
  ];
  const r = plan([file("s.mp4", null)], existing);
  assert.deepEqual(r.rows, [], "không được ghi đè segment đã đóng");
  assert.deepEqual(r.collisions, ["s.mp4"]);
});

test("DB đã đóng + agent gửi bản đã đóng → vẫn ghi (cập nhật bình thường)", () => {
  const existing: ExistingRecordingFile[] = [
    { camera_id: CAM, file_path: "s.mp4", ended_at: "2026-08-12T02:00:00Z" },
  ];
  const r = plan([file("s.mp4", "2026-08-12T02:00:30Z")], existing);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.collisions, []);
});

test("DB đang mở + agent gửi bản đã đóng → ghi (đây là ca đóng segment)", () => {
  const existing: ExistingRecordingFile[] = [
    { camera_id: CAM, file_path: "s.mp4", ended_at: null },
  ];
  const r = plan([file("s.mp4", "2026-08-12T03:01:00Z")], existing);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ended_at, "2026-08-12T03:01:00Z");
  assert.deepEqual(r.collisions, []);
});

test("row DB của camera KHÁC cùng file_path không gây collision nhầm", () => {
  // SELECT hàng loạt lọc theo file_path nên có thể kéo về row của camera
  // khác; ghép khoá phải gồm cả camera_id.
  const existing: ExistingRecordingFile[] = [
    { camera_id: CAM_KHAC, file_path: "s.mp4", ended_at: "2026-08-12T02:00:00Z" },
  ];
  const r = plan([file("s.mp4", null, CAM)], existing);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.collisions, []);
});

// ---------- Ca 4: chunk ----------

test("chunk chặn dưới trần .in() kể cả lô tối đa route cho phép (200)", () => {
  const items = Array.from({ length: 200 }, (_, i) => i);
  const parts = chunk(items);
  assert.equal(parts.length, 2);
  assert.ok(
    parts.every((p) => p.length <= DB_CHUNK_SIZE),
    "không mảnh nào vượt DB_CHUNK_SIZE",
  );
  assert.deepEqual(parts.flat(), items, "không mất và không đảo phần tử");
});

test("chunk: rỗng → không lượt gọi DB nào; đúng bằng trần → 1 lượt", () => {
  assert.deepEqual(chunk([]), []);
  assert.equal(chunk(Array.from({ length: DB_CHUNK_SIZE }, (_, i) => i)).length, 1);
});
