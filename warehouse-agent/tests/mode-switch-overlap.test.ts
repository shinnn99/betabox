import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReturnCaptureStore } from "../src/return-capture";

/**
 * Giao ca giữa hai luồng khi đoạn video đang ghi dở.
 *
 * Chủ dự án chốt 24/09/2026: "nếu luồng cũ vẫn chưa đóng segment cuối mà
 * đổi sang luồng mới thì segment của luồng cũ vẫn phải ghi nốt; nếu
 * segment luồng cũ đang ghi nốt mà segment luồng mới bắt đầu ghi thì phải
 * chạy song song cho đến khi luồng cũ kết thúc, rồi tắt luồng cũ đi để
 * chạy riêng luồng mới, và khi chuyển lại cũng vậy".
 *
 * Camera KHÔNG dừng ghi khi đổi luồng — nó ghi liên tục. Thứ đổi chủ là
 * QUYỀN SỞ HỮU đoạn video: đoạn nào mang nhãn phiên hoàn thì thuộc luồng
 * hoàn, đoạn không nhãn thuộc luồng đóng hàng. "Chạy song song" nghĩa là
 * trong lúc đoạn dở của luồng cũ chưa đóng, nó vẫn thuộc luồng cũ, còn
 * luồng mới đã bắt đầu tính từ đoạn kế tiếp.
 */

const CAM = "cam-1";

function makeStore(hasOpenSegment: () => boolean) {
  const sent: Array<Record<string, unknown>> = [];
  const store = new ReturnCaptureStore({
    getBackendUrl: () => "https://localhost:3000",
    agentCode: "AGENT_TEST",
    agentSecret: "secret",
    hasOpenSegment,
    send: async (payload) => {
      sent.push(payload);
      return true;
    },
  });
  const finished = () => sent.filter((p) => p.action === "finish").map((p) => String(p.capture_id));
  return { store, finished };
}

const signal = (id: string) => ({
  capture_id: id,
  station_id: "ban-1",
  camera_ids: [CAM],
  active: true,
});

async function withTempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "overlap-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
}

test("đóng hàng → hoàn hàng: đoạn đang ghi dở vẫn thuộc đóng hàng, đoạn kế tiếp mới là hoàn", async (t) => {
  await withTempDir(t);
  let recording = true; // đang ghi dở một đoạn của luồng đóng hàng
  const { store } = makeStore(() => recording);

  await store.apply(signal("hoan-1"));
  assert.equal(
    store.labelFor(CAM),
    null,
    "đoạn dở của đóng hàng KHÔNG được đổi chủ giữa chừng",
  );

  // Đoạn đó ghi nốt rồi đóng lại.
  recording = false;
  await store.noteSegmentClosed(CAM, new Date().toISOString());
  recording = true; // camera ghi tiếp đoạn mới

  assert.equal(store.labelFor(CAM), "hoan-1", "từ đoạn kế tiếp mới thuộc luồng hoàn");
});

test("hoàn hàng → đóng hàng: đoạn dở của hoàn ghi nốt xong mới tắt phiên", async (t) => {
  await withTempDir(t);
  let recording = false;
  const { store, finished } = makeStore(() => recording);

  await store.apply(signal("hoan-1"));
  recording = true; // camera bắt đầu một đoạn CỦA luồng hoàn
  assert.equal(store.labelFor(CAM), "hoan-1");

  // Đổi về đóng hàng trong lúc đoạn đó còn dở.
  await store.apply({ ...signal("hoan-1"), active: false });
  assert.deepEqual(finished(), [], "chưa được báo xong khi đoạn dở chưa lưu");
  assert.equal(
    store.labelFor(CAM),
    "hoan-1",
    "đoạn dở vẫn thuộc luồng hoàn — hai luồng chạy song song tới khi nó đóng",
  );

  // Đoạn dở đóng lại: luồng hoàn mới thật sự kết thúc.
  recording = false;
  await store.noteSegmentClosed(CAM, new Date().toISOString());
  recording = true;
  assert.deepEqual(finished(), ["hoan-1"], "đóng xong đoạn cuối mới báo xong");
  assert.equal(store.labelFor(CAM), null, "đoạn sau đó thuộc luồng đóng hàng");
});

test("chuyển qua lại nhiều lần khi lúc nào cũng có đoạn đang ghi dở", async (t) => {
  await withTempDir(t);
  let recording = true;
  const { store, finished } = makeStore(() => recording);
  const closeSegment = async () => {
    recording = false;
    await store.noteSegmentClosed(CAM, new Date().toISOString());
    recording = true;
  };

  for (let i = 1; i <= 6; i += 1) {
    const id = `hoan-${i}`;

    // Sang hoàn hàng: đoạn dở của đóng hàng giữ nguyên chủ.
    await store.apply(signal(id));
    assert.equal(store.labelFor(CAM), null, `vòng ${i}: đoạn dở vẫn của đóng hàng`);
    await closeSegment();
    assert.equal(store.labelFor(CAM), id, `vòng ${i}: đoạn kế tiếp thuộc hoàn hàng`);

    // Về đóng hàng: đoạn dở của hoàn hàng giữ nguyên chủ tới khi đóng.
    await store.apply({ ...signal(id), active: false });
    assert.equal(store.labelFor(CAM), id, `vòng ${i}: đoạn dở vẫn của hoàn hàng`);
    assert.ok(!finished().includes(id), `vòng ${i}: chưa báo xong khi đoạn còn dở`);
    await closeSegment();
    assert.ok(finished().includes(id), `vòng ${i}: đóng đoạn xong mới báo xong`);
    assert.equal(store.labelFor(CAM), null, `vòng ${i}: đoạn sau thuộc đóng hàng`);
  }
});

test("bật luồng hoàn mới trong lúc luồng hoàn cũ còn đang rút", async (t) => {
  await withTempDir(t);
  let recording = false;
  const { store, finished } = makeStore(() => recording);

  await store.apply(signal("hoan-1"));
  recording = true;
  await store.apply({ ...signal("hoan-1"), active: false }); // đang rút

  // Người dùng bật lại ngay: phiên MỚI không được cướp đoạn dở của phiên cũ.
  await store.apply(signal("hoan-2"));
  assert.equal(store.labelFor(CAM), "hoan-1", "đoạn dở vẫn của phiên đang rút");

  recording = false;
  await store.noteSegmentClosed(CAM, new Date().toISOString());
  recording = true;
  assert.deepEqual(finished(), ["hoan-1"], "phiên cũ kết thúc gọn");
  assert.equal(store.labelFor(CAM), "hoan-2", "từ đoạn kế tiếp là của phiên mới");
});
