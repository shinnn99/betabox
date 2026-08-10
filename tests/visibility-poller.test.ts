import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startVisibilityPolling,
  type VisibilityDoc,
} from "../src/lib/polling/visibility-poller.ts";

/**
 * Nhịp poll của dashboard phải im khi không ai nhìn.
 *
 * Chạy: pnpm test
 *
 * Bối cảnh: 08/08/2026 tài khoản Vercel bị khoá vì vượt cả bốn hạn mức, gốc
 * là các trang dashboard poll suốt ngày kể cả lúc tab bị ẩn. Hai vế dưới
 * đây phải đi cùng nhau — chỉ có vế "im khi ẩn" thì người dùng quay lại sẽ
 * nhìn số liệu cũ tới vài giây, và đó là cách chắc chắn nhất để lần tối ưu
 * này bị gỡ ra.
 */

/** document giả: tự bấm nhịp và tự phát visibilitychange được. */
function makeHarness(initial: string) {
  const listeners: Array<() => void> = [];
  let handleSeq = 0;
  const scheduled = new Map<number, { handler: () => void; ms: number }>();

  const doc: VisibilityDoc = {
    visibilityState: initial,
    addEventListener: (_type, handler) => {
      listeners.push(handler);
    },
    removeEventListener: (_type, handler) => {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  let ticks = 0;
  const stop = startVisibilityPolling({
    intervalMs: 3000,
    onTick: () => {
      ticks += 1;
    },
    doc,
    schedule: (handler, ms) => {
      const h = ++handleSeq;
      scheduled.set(h, { handler, ms });
      return h;
    },
    cancel: (handle) => {
      scheduled.delete(handle as number);
    },
  });

  return {
    doc,
    stop,
    ticks: () => ticks,
    intervalCount: () => scheduled.size,
    intervalMs: () => [...scheduled.values()][0]?.ms,
    /** Giả lập một nhịp interval trôi qua. */
    fireInterval: () => {
      for (const { handler } of scheduled.values()) handler();
    },
    /** Giả lập tab đổi trạng thái hiện/ẩn. */
    setVisibility: (state: string) => {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.length,
  };
}

test("không tự gọi lúc khởi tạo — lượt đầu do caller quyết", () => {
  const h = makeHarness("visible");
  assert.equal(h.ticks(), 0);
  assert.equal(h.intervalMs(), 3000);
  h.stop();
});

test("tab visible: mỗi nhịp interval gọi một lần", () => {
  const h = makeHarness("visible");
  h.fireInterval();
  h.fireInterval();
  assert.equal(h.ticks(), 2);
  h.stop();
});

test("tab hidden: nhịp interval trôi qua nhưng KHÔNG gọi", () => {
  const h = makeHarness("hidden");
  h.fireInterval();
  h.fireInterval();
  h.fireInterval();
  assert.equal(h.ticks(), 0, "tab ẩn mà vẫn bắn request là đúng cái bug cần chặn");
  h.stop();
});

test("quay lại visible: gọi NGAY, không chờ hết chu kỳ", () => {
  const h = makeHarness("hidden");
  h.fireInterval();
  assert.equal(h.ticks(), 0);

  h.setVisibility("visible");
  assert.equal(h.ticks(), 1, "phải làm mới ngay khi người dùng nhìn lại");
  h.stop();
});

test("chuyển sang hidden KHÔNG kích một lượt gọi thừa", () => {
  const h = makeHarness("visible");
  h.setVisibility("hidden");
  assert.equal(h.ticks(), 0);
  h.stop();
});

test("hidden → visible → hidden → visible: mỗi lần hiện lại đúng một lượt", () => {
  const h = makeHarness("hidden");
  h.setVisibility("visible");
  h.setVisibility("hidden");
  h.fireInterval();
  h.setVisibility("visible");
  assert.equal(h.ticks(), 2);
  h.stop();
});

test("cleanup gỡ cả interval lẫn listener — không rò nhịp sau khi rời trang", () => {
  const h = makeHarness("visible");
  assert.equal(h.intervalCount(), 1);
  assert.equal(h.listenerCount(), 1);

  h.stop();

  assert.equal(h.intervalCount(), 0);
  assert.equal(h.listenerCount(), 0);
  h.fireInterval();
  h.setVisibility("visible");
  assert.equal(h.ticks(), 0, "đã dọn mà vẫn gọi = rò nhịp qua mỗi lần đổi trang");
});
