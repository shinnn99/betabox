import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClipResultOutbox,
  isExpiredOutboxItem,
  isPermanentClipResultStatus,
  OUTBOX_MAX_AGE_HOURS,
  type OutboxClipResult,
  type QueuedClipResult,
} from "../src/clip-result-outbox";

/**
 * Outbox callback clip-cut-result.
 *
 * Ca gốc (2026-08-11): backend trả 451 (deployment Vercel cũ đã disable)
 * → callback mất → row clip kẹt 'pending' → UI "Đang cắt" vĩnh viễn.
 * Phân loại status là trái tim của bản vá: xếp nhầm 451 vào nhóm "bỏ
 * luôn" thì outbox vô dụng đúng ca đã cắn.
 */

test("451 PHẢI được giữ để gửi lại (ca đã cắn)", () => {
  assert.equal(isPermanentClipResultStatus(451), false);
});

test("4xx do nội dung request → bỏ, không gửi lại vô ích", () => {
  for (const s of [400, 403, 404]) {
    assert.equal(isPermanentClipResultStatus(s), true, `status ${s}`);
  }
});

test("401/5xx/lỗi mạng → giữ để gửi lại", () => {
  // 401 thường là lệch giờ / nonce / secret vừa rotate — hết lệch là qua.
  for (const s of [0, 401, 429, 500, 502, 503]) {
    assert.equal(isPermanentClipResultStatus(s), false, `status ${s}`);
  }
});

function item(enqueuedAt: string): QueuedClipResult {
  return {
    enqueued_at: enqueuedAt,
    attempt: 1,
    last_error: "http_451",
    payload: {
      clipId: "6f60fda4-f87d-4ec9-934a-5276f5a8c478",
      packingEventId: "ab03ab03-b732-493b-8446-99cda28094ca",
      cameraId: "3a5112e0-3197-4d55-badb-efc37418612e",
      waybillCode: "SPXVN068642901568",
      outcome: "failed",
      errorMessage: "signed_url_fetch_failed: http_451",
    } satisfies OutboxClipResult,
  };
}

const NOW = Date.parse("2026-08-11T09:00:00.000Z");

test("item mới → chưa quá hạn", () => {
  const fresh = item(new Date(NOW - 60 * 60_000).toISOString());
  assert.equal(isExpiredOutboxItem(fresh, NOW), false);
});

test(`item quá ${OUTBOX_MAX_AGE_HOURS}h → bỏ`, () => {
  const old = item(
    new Date(NOW - (OUTBOX_MAX_AGE_HOURS + 1) * 3600 * 1000).toISOString(),
  );
  assert.equal(isExpiredOutboxItem(old, NOW), true);
});

test("timestamp rác → coi là quá hạn, không giữ mãi", () => {
  assert.equal(isExpiredOutboxItem(item("rác"), NOW), true);
});

test("append → readAll → rewrite giữ đúng payload qua vòng đời", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "clip-outbox-"));
  const file = join(dir, "nested", "pending-clip-results.jsonl");
  const outbox = new ClipResultOutbox(file);

  // File chưa tồn tại → readAll trả rỗng, KHÔNG throw (ca boot lần đầu).
  assert.deepEqual(await outbox.readAll(), []);

  await outbox.append(item(new Date(NOW).toISOString()).payload, "http_451");
  const read = await outbox.readAll();
  assert.equal(read.length, 1);
  assert.equal(read[0].payload.waybillCode, "SPXVN068642901568");
  assert.equal(read[0].payload.outcome, "failed");
  assert.equal(read[0].last_error, "http_451");
  assert.equal(read[0].attempt, 1);
  // Secret KHÔNG được nằm trên ổ.
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes("agentSecret"), false);

  // Gửi xong → rewrite rỗng → file rỗng, readAll trả rỗng.
  await outbox.rewrite([]);
  await outbox.flushNow();
  assert.deepEqual(await outbox.readAll(), []);

  await fs.rm(dir, { recursive: true, force: true });
});

test("dòng hỏng → quarantine file, item đọc được vẫn giữ", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "clip-outbox-"));
  const file = join(dir, "pending-clip-results.jsonl");
  const good = JSON.stringify(item(new Date(NOW).toISOString()));
  await fs.writeFile(file, `${good}\n{"payload": KHÔNG-PHẢI-JSON\n`, "utf8");

  const outbox = new ClipResultOutbox(file);
  const read = await outbox.readAll();
  assert.equal(read.length, 1, "item đọc được không bị mất theo dòng hỏng");

  const files = await fs.readdir(dir);
  assert.ok(
    files.some((f) => f.includes("corrupt") || f !== "pending-clip-results.jsonl"),
    `phải có file quarantine, thấy: ${files.join(", ")}`,
  );

  await fs.rm(dir, { recursive: true, force: true });
});
