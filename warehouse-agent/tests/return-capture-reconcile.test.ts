import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReturnCaptureStore } from "../src/return-capture";

/**
 * Đồng bộ phiên ghi hoàn theo TRẠNG THÁI cloud (sự cố 24/09/2026).
 *
 * Chuyển từ đóng hàng sang hoàn hàng thì được, chuyển ngược lại thì không.
 * Gốc: agent chỉ tắt phiên khi nhận được LỆNH tắt, mà lệnh đó chỉ sinh ra
 * từ một đường duy nhất. Bốn đường đóng kỳ còn lại nằm gọn trong database
 * nên agent không hay biết — kiểm trên database thật thì MỌI lệnh
 * `set_return_capture` từng gửi đều `active=true`, chưa từng có lệnh tắt.
 *
 * Giờ mỗi nhịp heartbeat cloud gửi danh sách phiên đang bật, agent tự so.
 */

/**
 * Dựng một kho phiên với đường gửi lên cloud bị chặn lại để đọc được agent
 * đã báo gì. Trạng thái ghi ra file trong thư mục làm việc, nên mỗi bài
 * test chạy trong thư mục tạm riêng.
 */
function makeStore(opts: { hasOpenSegment?: (cameraId: string) => boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const store = new ReturnCaptureStore({
    getBackendUrl: () => "https://localhost:3000",
    agentCode: "AGENT_TEST",
    agentSecret: "secret",
    hasOpenSegment: opts.hasOpenSegment ?? (() => false),
    send: async (payload) => {
      sent.push(payload);
      return true;
    },
  });
  const finished = () =>
    sent.filter((p) => p.action === "finish").map((p) => String(p.capture_id));
  return { store, sent, finished };
}

const signal = (id: string, cameras = ["cam-1"]) => ({
  capture_id: id,
  station_id: "ban-1",
  camera_ids: cameras,
  active: true,
});

test("cloud không còn phiên → agent tắt phiên đó", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const { store, finished } = makeStore();
  await store.apply(signal("phien-1"));
  assert.equal(store.labelFor("cam-1"), "phien-1", "đang bật thì đoạn video mang nhãn phiên");

  // Bàn đã về đóng hàng ở cloud (hết giờ chờ / đóng ca / đổi mục đích bàn).
  await store.reconcile([]);
  assert.equal(store.labelFor("cam-1"), null, "hết phiên thì đoạn video KHÔNG còn nhãn hàng hoàn");
  assert.deepEqual(finished(), ["phien-1"], "phải báo cloud là đã xong");
});

test("cloud vẫn còn phiên → giữ nguyên, không tắt nhầm", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const { store, finished } = makeStore();
  await store.apply(signal("phien-1"));
  await store.reconcile([signal("phien-1")]);
  assert.equal(store.labelFor("cam-1"), "phien-1");
  assert.deepEqual(finished(), []);
});

test("cloud đang bật mà agent không giữ → nhận lại (lệnh rơi mất / vừa khởi động lại)", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const { store } = makeStore();
  assert.equal(store.labelFor("cam-1"), null);
  await store.reconcile([signal("phien-2")]);
  assert.equal(store.labelFor("cam-1"), "phien-2");
});

test("bàn đổi camera thì cập nhật, không dựng phiên mới", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const { store, finished } = makeStore();
  await store.apply(signal("phien-1", ["cam-1"]));
  await store.reconcile([signal("phien-1", ["cam-1", "cam-2"])]);
  assert.equal(store.labelFor("cam-2"), "phien-1", "camera mới gắn vào bàn cũng mang nhãn");
  assert.deepEqual(finished(), [], "không được kết thúc phiên đang chạy");
});

test("bật rồi tắt rồi bật lại nhiều lần đều đúng nhãn", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const { store } = makeStore();
  for (let i = 1; i <= 10; i += 1) {
    const id = `phien-${i}`;
    await store.reconcile([signal(id)]);
    assert.equal(store.labelFor("cam-1"), id, `vòng ${i}: bật thì phải mang nhãn ${id}`);
    await store.reconcile([]);
    assert.equal(store.labelFor("cam-1"), null, `vòng ${i}: tắt thì phải hết nhãn`);
  }
});

test("phiên đang rút không bị đồng bộ cắt ngang", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "rc-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  // Lúc BẬT chưa có đoạn dở (nếu có thì đoạn đó là của module trước, phiên
  // này hoãn nhận). Đoạn dở xuất hiện SAU, tức là đoạn của chính phiên
  // này — tắt lúc đó phải chờ nó lưu xong.
  let recording = false;
  const { store, finished } = makeStore({ hasOpenSegment: () => recording });
  await store.apply(signal("phien-1"));
  recording = true;
  await store.apply({ ...signal("phien-1"), active: false });
  assert.deepEqual(finished(), [], "còn đoạn dở thì chưa báo xong");
  await store.reconcile([]);
  assert.deepEqual(finished(), [], "đồng bộ không được ép xong khi đoạn dở chưa lưu");
  assert.equal(store.labelFor("cam-1"), "phien-1", "đoạn dở vẫn thuộc phiên cũ cho tới khi đóng");
});
