import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScanQueue, scanQueueKey } from "../src/queue";
import { SegmentReportQueue, reportQueueKey } from "../src/segment-report-queue";
import { ClipResultOutbox, outboxKey } from "../src/clip-result-outbox";
import { AsyncMutex, isPermanentRejection } from "../src/queue-lock";
import type { ScanPayload } from "../src/sender";

/**
 * 0.13.0 — lỗi MẤT dữ liệu trong hàng đợi (tìm ra 26/09/2026): vòng gửi lại
 * đọc bản chụp, gửi (mạng nghẽn: vài phút), rồi ghi đè cả file bằng phần gửi
 * chưa được → dòng thêm vào TRONG LÚC đó mất. Các bài dưới dựng lại đúng
 * trình tự đó.
 */

const scan = (code: string, at: string): ScanPayload => ({
  agent_event_id: `id-${code}`,
  scanner_device_code: "qrcam_cqr01",
  port: "camera:CQR01",
  raw_value: code,
  scanned_at: at,
  source: "camera_qr",
  device_identity_snapshot: null,
});

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "q013-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("hàng đợi lượt quét: dòng thêm GIỮA LÚC đang gửi KHÔNG bị mất", async () => {
  await withDir(async (dir) => {
    const q = new ScanQueue(join(dir, "pending-scans.jsonl"));
    await q.append(scan("A", "2026-09-26T02:44:06Z"));
    await q.append(scan("B", "2026-09-26T02:44:36Z"));

    // Vòng gửi lại chụp hàng đợi...
    const snapshot = await q.readAll();
    assert.equal(snapshot.length, 2);
    // ...trong lúc đang gửi (mạng nghẽn), camera đọc thêm mã C:
    await q.append(scan("C", "2026-09-26T02:45:20Z"));
    // ...gửi xong A và B, dọn đúng hai dòng đó:
    const sent = new Set(snapshot.map(scanQueueKey));
    await q.removeWhere((item) => sent.has(scanQueueKey(item)));

    const left = await q.readAll();
    assert.deepEqual(left.map((i) => i.payload.raw_value), ["C"], "C phải còn — bản 0.12.x ghi đè mất C");
    assert.equal(await q.count(), 1);
  });
});

test("hàng đợi lượt quét: thêm và dọn chạy chồng nhau vẫn không mất dòng nào", async () => {
  await withDir(async (dir) => {
    const q = new ScanQueue(join(dir, "pending-scans.jsonl"));
    const codes = Array.from({ length: 30 }, (_, i) => `M${String(i).padStart(2, "0")}`);
    await Promise.all(codes.slice(0, 10).map((c, i) => q.append(scan(c, `2026-09-26T03:00:${String(i).padStart(2, "0")}Z`))));
    const snapshot = await q.readAll();
    const sent = new Set(snapshot.map(scanQueueKey));
    // Dọn và thêm cùng lúc — đúng kiểu hai vòng timer chồng nhau.
    await Promise.all([
      q.removeWhere((item) => sent.has(scanQueueKey(item))),
      ...codes.slice(10).map((c, i) => q.append(scan(c, `2026-09-26T03:01:${String(i).padStart(2, "0")}Z`))),
    ]);
    const left = (await q.readAll()).map((i) => i.payload.raw_value).sort();
    assert.deepEqual(left, codes.slice(10).sort());
  });
});

test("khoá so trùng ổn định kể cả với dòng cũ thiếu agent_event_id", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "pending-scans.jsonl");
    const legacy = { enqueued_at: "x", attempt: 0, payload: { ...scan("OLD", "2026-09-26T01:00:00Z"), agent_event_id: undefined } };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(legacy) + "\n", "utf8");
    const q = new ScanQueue(file);
    const a = await q.readAll();
    const b = await q.readAll();
    assert.notEqual(a[0].payload.agent_event_id, b[0].payload.agent_event_id, "readAll gán id ngẫu nhiên mỗi lần");
    assert.equal(scanQueueKey(a[0]), scanQueueKey(b[0]), "nhưng khoá so trùng thì không đổi");
    await q.removeWhere((item) => item.payload.raw_value === "OLD");
    assert.equal(await q.count(), 0);
  });
});

test("hàng đợi báo đoạn video: báo 'đóng' thêm giữa lúc gửi không bị mất; 'mở' và 'đóng' là hai dòng", async () => {
  await withDir(async (dir) => {
    const q = new SegmentReportQueue(join(dir, "pending-segment-reports.jsonl"));
    const seg = {
      camera_id: "cam-1",
      session_id: null,
      file_path: "CTC01/2026/09/26/CTC01_20260926_094400.mp4",
      file_name: "CTC01_20260926_094400.mp4",
      started_at: "2026-09-26T02:44:00Z",
      ended_at: null,
      duration_seconds: null,
      file_size_bytes: null,
    };
    await q.append(seg);
    const snapshot = await q.readAll();
    await q.appendMany([{ ...seg, ended_at: "2026-09-26T02:45:00Z", duration_seconds: 60, file_size_bytes: 40_000_000 }]);
    const sent = new Set(snapshot.map(reportQueueKey));
    await q.removeWhere((item) => sent.has(reportQueueKey(item)));
    const left = await q.readAll();
    assert.equal(left.length, 1);
    assert.equal(left[0].payload.ended_at, "2026-09-26T02:45:00Z", "báo ĐÓNG phải còn — mất nó là đoạn 'mở' mãi, clip không cắt được");
  });
});

test("hộp thư kết quả cắt clip: kết quả mới thêm giữa lúc gửi không bị mất", async () => {
  await withDir(async (dir) => {
    const box = new ClipResultOutbox(join(dir, "pending-clip-results.jsonl"));
    const payload = (clipId: string) => ({ clipId, outcome: "ready" }) as never;
    await box.append(payload("clip-1"), "network");
    const snapshot = await box.readAll();
    await box.append(payload("clip-2"), "network");
    const sent = new Set(snapshot.map(outboxKey));
    await box.removeWhere((item) => sent.has(outboxKey(item)));
    const left = await box.readAll();
    assert.deepEqual(left.map((i) => (i.payload as { clipId: string }).clipId), ["clip-2"]);
  });
});

test("khoá tuần tự: chạy đúng thứ tự, một lượt lỗi không làm gãy lượt sau", async () => {
  const m = new AsyncMutex();
  const order: number[] = [];
  const slow = m.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push(1);
  });
  const failing = m.run(async () => {
    order.push(2);
    throw new Error("x");
  });
  const after = m.run(async () => {
    order.push(3);
  });
  await slow;
  await assert.rejects(failing);
  await after;
  assert.deepEqual(order, [1, 2, 3]);
});

test("từ chối vĩnh viễn chỉ gồm 400/413/422 — mạng / 5xx / 401 / 429 vẫn gửi lại", () => {
  for (const s of [400, 413, 422]) assert.equal(isPermanentRejection(s), true, String(s));
  for (const s of [0, 401, 403, 404, 408, 429, 500, 502, 503]) assert.equal(isPermanentRejection(s), false, String(s));
});

test("vòng gửi lại: không ghi đè bằng bản chụp, không chạy chồng; một clip một lúc tính cả lúc tải lên", () => {
  const index = readFileSync("src/index.ts", "utf8");
  assert.ok(!index.includes("await queue.rewrite(remaining);"), "cách ghi đè cũ phải bỏ");
  assert.ok(index.includes("if (scanFlushInFlight) return;"));
  assert.ok(index.includes("await queue.removeWhere((item) => settled.has(scanQueueKey(item)));"));
  assert.ok(index.includes('if (outcome === "retry") await queue.append(payload);'), "từ chối vĩnh viễn không vào hàng đợi");
  assert.ok(index.includes("encodingBusy: encodeGate.isBusy() || clipJobsInFlight > 0,"));
  assert.ok(index.includes("await clipResultOutbox.removeWhere((item) => settled.has(outboxKey(item)));"));
  const seg = readFileSync("src/segment-index.ts", "utf8");
  assert.ok(seg.includes("if (this.flushInFlight) return;"));
  assert.ok(!seg.includes("await this.queue.rewrite(remaining);"));
});
