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

// ===========================================================================
// Nhịp CO GIÃN (06/10/2026) — intervalMs truyền vào dạng hàm.
//
// Dạng này dùng setTimeout tự hẹn lại thay vì setInterval, vì setInterval
// không đổi được chu kỳ sau khi đã đặt. Kéo theo một bẫy riêng: nếu quên hẹn
// lại lúc tab đang ẩn thì vòng nhịp chết hẳn — test dưới giữ đúng chỗ đó.
// ===========================================================================

/** Harness cho nhịp co giãn: nhịp đọc từ biến đổi được giữa chừng. */
function makeDynamicHarness(initial: string, firstMs: number) {
  const listeners: Array<() => void> = [];
  let handleSeq = 0;
  const scheduled = new Map<number, { handler: () => void; ms: number }>();
  let currentMs = firstMs;
  let ticks = 0;

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

  const stop = startVisibilityPolling({
    intervalMs: () => currentMs,
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
    stop,
    ticks: () => ticks,
    pendingCount: () => scheduled.size,
    /** Nhịp của lần hẹn đang chờ. */
    pendingMs: () => [...scheduled.values()][0]?.ms,
    setInterval: (ms: number) => {
      currentMs = ms;
    },
    /** Chạy lần hẹn đang chờ (nó sẽ tự hẹn lại lần kế). */
    fireTimeout: () => {
      const entries = [...scheduled.entries()];
      for (const [h, { handler }] of entries) {
        scheduled.delete(h);
        handler();
      }
    },
    setVisibility: (state: string) => {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
  };
}

test("nhịp co giãn mặc định dùng setTimeout thật, chỉ giữ MỘT timer", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  let handleSeq = 0;
  let intervalCalls = 0;
  const pending = new Map<number, () => void>();
  const listeners: Array<() => void> = [];
  const doc: VisibilityDoc = {
    visibilityState: "visible",
    addEventListener: (_type, handler) => listeners.push(handler),
    removeEventListener: (_type, handler) => {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  globalThis.setTimeout = ((handler: () => void) => {
    const handle = ++handleSeq;
    pending.set(handle, handler);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: number) => {
    pending.delete(handle);
  }) as typeof clearTimeout;
  globalThis.setInterval = (() => {
    intervalCalls += 1;
    return 99_999;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;

  let stop: (() => void) | null = null;
  let ticks = 0;
  try {
    // Không truyền schedule/cancel: test đúng scheduler MẶC ĐỊNH production.
    stop = startVisibilityPolling({
      intervalMs: () => 3000,
      onTick: () => {
        ticks += 1;
      },
      doc,
    });

    assert.equal(intervalCalls, 0, "nhịp động tuyệt đối không được dùng setInterval");
    assert.equal(pending.size, 1, "khởi tạo chỉ được có một timeout");

    const [firstHandle, firstCallback] = [...pending.entries()][0];
    pending.delete(firstHandle); // setTimeout one-shot tự biến mất trước callback.
    firstCallback();

    assert.equal(ticks, 1);
    assert.equal(pending.size, 1, "mỗi callback chỉ hẹn đúng một timeout kế tiếp");

    const callbackAfterCleanup = [...pending.values()][0];
    stop();
    stop = null;
    assert.equal(pending.size, 0, "cleanup phải huỷ timeout đang chờ");

    // Callback đã được event loop lấy ra ngay trước cleanup vẫn phải bị chặn
    // bởi cờ stopped: không tick và không tự hẹn lại.
    callbackAfterCleanup();
    assert.equal(ticks, 1);
    assert.equal(pending.size, 0);
  } finally {
    stop?.();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("nhịp co giãn: lần hẹn đầu dùng đúng nhịp hiện hành", () => {
  const h = makeDynamicHarness("visible", 3000);
  assert.equal(h.pendingMs(), 3000);
  h.stop();
});

test("nhịp co giãn: đổi nhịp giữa chừng có hiệu lực ở lần hẹn KẾ TIẾP", () => {
  const h = makeDynamicHarness("visible", 3000);
  h.setInterval(30_000);
  h.fireTimeout(); // lượt này đang chạy theo nhịp cũ, rồi hẹn lại
  assert.equal(h.ticks(), 1);
  assert.equal(h.pendingMs(), 30_000, "nhịp mới phải ăn ngay lần hẹn sau");
  h.stop();
});

test("nhịp co giãn: tab ẩn bỏ lượt GỌI nhưng KHÔNG giết vòng hẹn", () => {
  // Bẫy của setTimeout tự hẹn: quên hẹn lại khi tab ẩn thì nhịp chết vĩnh
  // viễn, người dùng quay lại thấy màn hình đứng im mãi.
  const h = makeDynamicHarness("hidden", 3000);
  h.fireTimeout();
  assert.equal(h.ticks(), 0, "tab ẩn thì không gọi");
  assert.equal(h.pendingCount(), 1, "nhưng vòng hẹn phải còn sống");

  h.fireTimeout();
  assert.equal(h.pendingCount(), 1);
  h.stop();
});

test("nhịp co giãn: ẩn rồi hiện lại vẫn chạy tiếp bình thường", () => {
  const h = makeDynamicHarness("hidden", 3000);
  h.fireTimeout();
  assert.equal(h.ticks(), 0);

  h.setVisibility("visible"); // gọi ngay một lượt
  assert.equal(h.ticks(), 1);

  h.fireTimeout(); // vòng hẹn vẫn sống nên lượt này ăn
  assert.equal(h.ticks(), 2);
  h.stop();
});

test("nhịp co giãn: dọn xong thì không hẹn lại nữa", () => {
  const h = makeDynamicHarness("visible", 3000);
  h.stop();
  assert.equal(h.pendingCount(), 0);

  h.fireTimeout();
  h.setVisibility("visible");
  assert.equal(h.ticks(), 0, "đã dọn mà vẫn hẹn lại = rò nhịp");
  assert.equal(h.pendingCount(), 0);
});
