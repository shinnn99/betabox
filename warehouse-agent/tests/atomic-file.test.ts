import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  quarantineCorruptQueue,
  SerializedWriter,
} from "../src/atomic-file";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "atomic-file-test-"));
}

// ============================================================================
// atomicWriteFile
// ============================================================================

test("atomicWriteFile: tạo file mới với nội dung đúng", async () => {
  const dir = await makeDir();
  try {
    const f = path.join(dir, "queue.jsonl");
    await atomicWriteFile(f, "line1\nline2\n");
    const raw = await readFile(f, "utf8");
    assert.equal(raw, "line1\nline2\n");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("atomicWriteFile: overwrite file hiện có", async () => {
  const dir = await makeDir();
  try {
    const f = path.join(dir, "queue.jsonl");
    await writeFile(f, "old content", "utf8");
    await atomicWriteFile(f, "new content");
    const raw = await readFile(f, "utf8");
    assert.equal(raw, "new content");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("atomicWriteFile: KHÔNG để lại .tmp file khi rename thành công", async () => {
  const dir = await makeDir();
  try {
    const f = path.join(dir, "queue.jsonl");
    await atomicWriteFile(f, "data");
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, "không có .tmp file rác");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("atomicWriteFile: tạo thư mục cha nếu chưa có", async () => {
  const dir = await makeDir();
  try {
    const f = path.join(dir, "subdir", "queue.jsonl");
    await atomicWriteFile(f, "data");
    assert.equal(existsSync(f), true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ============================================================================
// quarantineCorruptQueue
// ============================================================================

test("quarantineCorruptQueue: move file sang _quarantine/queue-corrupt/", async () => {
  const dir = await makeDir();
  try {
    const f = path.join(dir, "queue.jsonl");
    await writeFile(f, "corrupt content", "utf8");
    const dest = await quarantineCorruptQueue(
      f,
      "parse_error",
      new Date("2026-07-07T15:30:00Z"),
    );
    assert.ok(dest);
    assert.match(
      dest!,
      /_quarantine[\\/]queue-corrupt[\\/]20260707T153000Z_queue\.jsonl_parse_error$/,
    );
    assert.equal(existsSync(f), false, "file gốc đã move");
    assert.equal(existsSync(dest!), true, "file đã ở dest");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("quarantineCorruptQueue: file không tồn tại → null", async () => {
  const dir = await makeDir();
  try {
    const dest = await quarantineCorruptQueue(
      path.join(dir, "missing.jsonl"),
      "reason",
    );
    assert.equal(dest, null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ============================================================================
// SerializedWriter
// ============================================================================

test("SerializedWriter: coalesce nhiều schedule → chỉ 1 write cuối", async () => {
  const writes: string[] = [];
  const w = new SerializedWriter(30, async (payload: string) => {
    writes.push(payload);
  });
  // 3 schedule cách nhau 5ms, coalesce 30ms → chỉ 1 write cuối.
  const p1 = w.schedule("a");
  await new Promise((r) => setTimeout(r, 5));
  const p2 = w.schedule("b");
  await new Promise((r) => setTimeout(r, 5));
  const p3 = w.schedule("c");
  await Promise.all([p1, p2, p3]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], "c");
});

test("SerializedWriter: flushNow chạy ngay không chờ timer", async () => {
  let called = false;
  const w = new SerializedWriter(10_000, async () => {
    called = true;
  });
  const p = w.schedule("payload");
  await w.flushNow();
  await p;
  assert.equal(called, true);
});

test("SerializedWriter: writes tuần tự — writer thứ 2 chờ writer 1 xong", async () => {
  const order: string[] = [];
  const w = new SerializedWriter(5, async (payload: string) => {
    order.push(`start:${payload}`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(`end:${payload}`);
  });
  // Schedule payload 1, chờ flush start, schedule payload 2.
  const p1 = w.schedule("A");
  await new Promise((r) => setTimeout(r, 15)); // đủ để timer trigger
  const p2 = w.schedule("B");
  await Promise.all([p1, p2]);
  // Bảo đảm start:A → end:A → start:B → end:B.
  assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B"]);
});

test("SerializedWriter: writer error reject promise; batch sau vẫn chạy được", async () => {
  const writes: string[] = [];
  let firstThrow = true;
  const w = new SerializedWriter(5, async (payload: string) => {
    if (firstThrow) {
      firstThrow = false;
      throw new Error("boom");
    }
    writes.push(payload);
  });
  const p1 = w.schedule("first");
  let threw = false;
  try {
    await p1;
  } catch (err) {
    threw = true;
    assert.match((err as Error).message, /boom/);
  }
  assert.equal(threw, true, "waiter phải nhận reject");
  const p2 = w.schedule("second");
  await p2;
  assert.deepEqual(writes, ["second"]);
});
