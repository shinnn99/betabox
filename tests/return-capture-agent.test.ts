import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReturnCaptureStore } from "../warehouse-agent/src/return-capture.ts";

/**
 * Hành vi của phiên ghi hoàn phía agent, mô phỏng segment 60 giây cuộn.
 *
 * Luật cần giữ (chủ dự án chốt 21/09/2026), hai chiều đối xứng:
 *   - Đổi SANG module hoàn giữa lúc đang ghi dở đoạn của luồng đóng hàng:
 *     đoạn đó vẫn ghi nốt và vẫn thuộc luồng ĐÓNG HÀNG (nó bọc phần kết
 *     thúc của video đơn đi). Phiên hoàn nhận từ đoạn kế tiếp.
 *   - Thoát module hoàn giữa lúc đang ghi dở: đoạn đó vẫn ghi nốt và vẫn
 *     thuộc phiên HOÀN. Phiên chỉ kết thúc sau khi đoạn đó đóng hẳn.
 */

const CAM = "cam-1";
const CAPTURE = "cap-1";

/** Camera giả: biết đoạn nào đang mở, và cuộn giống SegmentTracker. */
class FakeCamera {
  open: string | null = null;
  private n = 0;
  private clock = Date.parse("2026-09-21T02:00:00.000Z");
  private readonly store: ReturnCaptureStore;
  constructor(store: ReturnCaptureStore) {
    this.store = store;
  }

  /** ffmpeg mở đoạn đầu tiên. Trả về nhãn của đoạn vừa mở. */
  start(): string | null {
    this.open = `seg-${++this.n}`;
    return this.store.labelFor(CAM);
  }

  /**
   * Cuộn: đóng đoạn đang mở, mở đoạn mới. Làm đúng thứ tự của
   * SegmentIndex.stamp: gán nhãn đoạn cũ → báo đóng → gán nhãn đoạn mới.
   */
  async roll(): Promise<{ closed: string; closedLabel: string | null; opened: string; openedLabel: string | null }> {
    const closed = this.open!;
    const closedLabel = this.store.labelFor(CAM);
    this.clock += 60_000;
    const endedAt = new Date(this.clock).toISOString();
    this.open = null;
    await this.store.noteSegmentClosed(CAM, endedAt);
    const opened = `seg-${++this.n}`;
    this.open = opened;
    const openedLabel = this.store.labelFor(CAM);
    return { closed, closedLabel, opened, openedLabel };
  }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "return-capture-"));
  process.chdir(dir);
  const sent: Array<Record<string, unknown>> = [];
  let cam: FakeCamera | null = null;
  const store = new ReturnCaptureStore({
    getBackendUrl: () => "http://unused",
    agentCode: "AG-TEST",
    agentSecret: "secret",
    hasOpenSegment: () => cam?.open !== null && cam?.open !== undefined,
    send: async (p) => {
      sent.push(p);
      return true;
    },
  });
  cam = new FakeCamera(store);
  return { store, cam, sent };
}

const cwd = process.cwd();
const on = { capture_id: CAPTURE, station_id: "ban-1", camera_ids: [CAM], active: true };
const off = { ...on, active: false };

test("đổi sang module hoàn giữa đoạn đóng hàng: đoạn đó ghi nốt và KHÔNG bị gán nhãn hoàn", async () => {
  const { store, cam } = setup();
  try {
    assert.equal(cam.start(), null, "trước tín hiệu thì không có nhãn");

    await store.apply(on); // BẬT giữa lúc seg-1 (đóng hàng) đang ghi dở

    const r1 = await cam.roll();
    assert.equal(r1.closed, "seg-1");
    assert.equal(r1.closedLabel, null, "đoạn bọc phần kết thúc đơn đi phải giữ cho luồng đóng hàng");
    assert.equal(r1.openedLabel, CAPTURE, "đoạn kế tiếp mới thuộc phiên hoàn");

    const r2 = await cam.roll();
    assert.equal(r2.closedLabel, CAPTURE);
  } finally {
    process.chdir(cwd);
  }
});

test("bật khi camera chưa có đoạn dở: nhận ngay từ đoạn đầu tiên", async () => {
  const { store, cam } = setup();
  try {
    await store.apply(on);
    assert.equal(cam.start(), CAPTURE);
  } finally {
    process.chdir(cwd);
  }
});

test("thoát module hoàn giữa đoạn: đoạn đó ghi nốt, vẫn thuộc phiên hoàn, rồi mới báo xong", async () => {
  const { store, cam, sent } = setup();
  try {
    await store.apply(on);
    cam.start(); // seg-1 thuộc phiên hoàn

    await store.apply(off); // TẮT giữa lúc seg-1 đang ghi dở
    assert.equal(
      sent.filter((p) => p.action === "finish").length,
      0,
      "chưa được báo xong khi đoạn cuối còn đang ghi",
    );

    const r = await cam.roll();
    assert.equal(r.closedLabel, CAPTURE, "đoạn đang ghi dở lúc thoát vẫn là của phiên hoàn");
    assert.equal(r.openedLabel, null, "đoạn mở sau đó đã về luồng đóng hàng");

    const finish = sent.filter((p) => p.action === "finish");
    assert.equal(finish.length, 1, "báo xong đúng một lần, sau khi đoạn cuối đóng");
    assert.equal(finish[0].last_segment_ended_at, "2026-09-21T02:01:00.000Z");
  } finally {
    process.chdir(cwd);
  }
});

test("bật rồi tắt ngay trong cùng đoạn đóng hàng: không chờ đoạn không thuộc mình", async () => {
  const { store, cam, sent } = setup();
  try {
    cam.start(); // seg-1 của luồng đóng hàng
    await store.apply(on);
    await store.apply(off);

    const finish = sent.filter((p) => p.action === "finish");
    assert.equal(finish.length, 1, "phiên phải kết thúc ngay, không treo chờ đoạn đóng hàng");

    const r = await cam.roll();
    assert.equal(r.closedLabel, null, "đoạn đó vẫn nguyên của luồng đóng hàng");
    assert.equal(r.openedLabel, null);
  } finally {
    process.chdir(cwd);
  }
});

test("agent khởi động lại giữa phiên: nhớ đoạn nào còn là của luồng đóng hàng", async () => {
  const { store, cam } = setup();
  try {
    cam.start();
    await store.apply(on); // seg-1 bị hoãn nhận

    // Máy khởi động lại: dựng store mới đọc từ file.
    const again = new ReturnCaptureStore({
      getBackendUrl: () => "http://unused",
      agentCode: "AG-TEST",
      agentSecret: "secret",
      hasOpenSegment: () => true,
      send: async () => true,
    });
    await again.load();
    assert.equal(again.labelFor(CAM), null, "đoạn đóng hàng dở dang không được mất trạng thái hoãn");
  } finally {
    process.chdir(cwd);
  }
});

// ---------------------------------------------------------------------------
// Chuyển qua lại giữa hai module (chủ dự án chốt 21/09/2026): đoạn dở luôn
// ghi nốt cho module cũ, module mới nhận từ đoạn kế tiếp — cả hai chiều,
// bao nhiêu lần cũng vậy.
// ---------------------------------------------------------------------------

test("chuyển qua lại nhiều lần: mỗi đoạn thuộc đúng module lúc nó BẮT ĐẦU ghi", async () => {
  const { store, cam, sent } = setup();
  try {
    cam.start(); // seg-1: đóng hàng
    const A = { ...on, capture_id: "cap-A" };
    const B = { ...on, capture_id: "cap-B" };

    await store.apply(A); // → HOÀN giữa seg-1
    let r = await cam.roll(); // seg-1 đóng, seg-2 mở
    assert.equal(r.closedLabel, null, "seg-1 ghi nốt cho đóng hàng");
    assert.equal(r.openedLabel, "cap-A", "seg-2 là của hoàn");

    await store.apply({ ...A, active: false }); // → ĐÓNG HÀNG giữa seg-2
    r = await cam.roll(); // seg-2 đóng, seg-3 mở
    assert.equal(r.closedLabel, "cap-A", "seg-2 ghi nốt cho hoàn");
    assert.equal(r.openedLabel, null, "seg-3 là của đóng hàng");
    assert.equal(sent.filter((p) => p.action === "finish" && p.capture_id === "cap-A").length, 1);

    await store.apply(B); // → HOÀN lần nữa giữa seg-3
    r = await cam.roll(); // seg-3 đóng, seg-4 mở
    assert.equal(r.closedLabel, null, "seg-3 ghi nốt cho đóng hàng");
    assert.equal(r.openedLabel, "cap-B", "chuyển lại thì bắt đầu nhận từ đoạn kế tiếp");
  } finally {
    process.chdir(cwd);
  }
});

test("hoàn → đóng hàng → hoàn trong CÙNG một đoạn: đoạn đó vẫn của phiên cũ, phiên cũ không bị báo xong sớm", async () => {
  const { store, cam, sent } = setup();
  try {
    const A = { ...on, capture_id: "cap-A" };
    const B = { ...on, capture_id: "cap-B" };
    await store.apply(A);
    assert.equal(cam.start(), "cap-A"); // seg-1 của phiên A

    await store.apply({ ...A, active: false }); // thoát giữa seg-1
    await store.apply(B); // vào lại ngay, seg-1 vẫn đang ghi

    assert.equal(
      sent.filter((p) => p.action === "finish").length,
      0,
      "phiên A chưa được xong: đoạn cuối của nó còn đang ghi",
    );
    assert.equal(store.labelFor(CAM), "cap-A", "đoạn dở không bị phiên mới cướp nhãn");

    const r = await cam.roll();
    assert.equal(r.closedLabel, "cap-A", "seg-1 lưu nốt cho phiên A");
    assert.equal(r.openedLabel, "cap-B", "phiên B nhận từ seg-2");

    const finish = sent.filter((p) => p.action === "finish");
    assert.equal(finish.length, 1);
    assert.equal(finish[0].capture_id, "cap-A");
    assert.equal(finish[0].last_segment_ended_at, "2026-09-21T02:01:00.000Z");
  } finally {
    process.chdir(cwd);
  }
});

test("hai bàn cùng nhận hoàn: bàn thứ hai bật không đè mất phiên bàn thứ nhất", async () => {
  const { store } = setup();
  try {
    await store.apply({ capture_id: "cap-1", station_id: "ban-1", camera_ids: ["cam-a"], active: true });
    await store.apply({ capture_id: "cap-2", station_id: "ban-2", camera_ids: ["cam-b"], active: true });
    assert.equal(store.labelFor("cam-a"), "cap-1");
    assert.equal(store.labelFor("cam-b"), "cap-2");
    assert.equal(store.labelFor("cam-khac"), null, "camera không thuộc bàn nào đang hoàn thì không nhãn");
  } finally {
    process.chdir(cwd);
  }
});

test("lệnh BẬT giao trễ sau khi phiên đã xong không làm phiên sống lại", async () => {
  const { store, cam } = setup();
  try {
    await store.apply(on);
    await store.apply(off); // không có đoạn dở → xong ngay
    await store.apply(on); // lệnh BẬT cũ bị giao lại
    assert.equal(cam.start(), null, "sống lại là gán nhãn mãi không dừng");
  } finally {
    process.chdir(cwd);
  }
});
