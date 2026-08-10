import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reportProbes } from "../warehouse-agent/src/camera-probe.ts";

/**
 * Agent gộp hai lượt gọi mỗi nhịp probe thành một.
 *
 * Chạy: pnpm test
 *
 * Trước: mỗi 30s agent gọi recording-credentials?all_active để biết org còn
 * công nhận camera nào, RỒI gọi camera-probe để báo kết quả. Nay cloud gửi
 * kèm danh sách vào chính phản hồi probe — 172.800 → 86.400 request/tháng
 * cho một agent chạy 24/7.
 *
 * Cạnh nguy hiểm của việc gộp nằm ở giá trị TRẢ VỀ KHI HỎNG. Danh sách này
 * là nguồn để agent thu hồi desired-recording: mảng rỗng nghĩa là "org
 * không còn camera nào" → agent tắt ghi hình toàn kho. Nếu lúc rớt mạng mà
 * hàm trả `[]` thay vì `null`, một nhịp mạng chập sẽ dừng ghi cả kho và
 * không ai biết cho tới khi cần trích xuất bằng chứng.
 */

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const PROBES = [{ camera_id: "cam-1", ok: true, latency_ms: 12 }];
const PARAMS = {
  backendUrl: "https://example.test",
  agentCode: "AG-1",
  agentSecret: "s3cret",
  probes: PROBES,
};

function stubFetch(impl: () => Promise<Response> | Response) {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return impl();
  }) as typeof globalThis.fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("xin kèm danh sách → trả về danh sách cloud gửi", async () => {
  const items = [
    { camera_id: "cam-1", camera_code: "hik_01", rtsp_url: "rtsp://x/1" },
  ];
  const calls = stubFetch(() => jsonResponse({ ok: true, active_cameras: items }));

  const got = await reportProbes({ ...PARAMS, wantActiveCameras: true });

  assert.deepEqual(got, items);
  assert.equal(calls.length, 1, "phải đúng MỘT request cho cả báo cáo lẫn xin danh sách");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.want_active_cameras, true);
  assert.deepEqual(body.probes, PROBES);
});

test("không xin → trả null và KHÔNG bật cờ trong body", async () => {
  const calls = stubFetch(() => jsonResponse({ ok: true, active_cameras: [] }));

  const got = await reportProbes(PARAMS);

  assert.equal(got, null);
  assert.equal(JSON.parse(calls[0].body).want_active_cameras, false);
});

test("HTTP lỗi → null, KHÔNG phải mảng rỗng", async () => {
  stubFetch(() => jsonResponse({ error: "probe_apply_failed" }, 500));

  const got = await reportProbes({ ...PARAMS, wantActiveCameras: true });

  assert.equal(
    got,
    null,
    "trả [] ở đây là agent hiểu 'org hết camera' và tắt ghi hình toàn kho",
  );
});

test("mạng chết giữa chừng → null, không ném ra ngoài vòng probe", async () => {
  stubFetch(() => {
    throw new Error("ECONNRESET");
  });

  const got = await reportProbes({ ...PARAMS, wantActiveCameras: true });
  assert.equal(got, null);
});

test("cloud trả 200 nhưng thiếu active_cameras → null", async () => {
  // Ca này xảy ra thật: route bỏ field khi query credential hỏng, để phần
  // ghi probe vẫn tính là thành công.
  stubFetch(() => jsonResponse({ ok: true, updated: 1 }));

  const got = await reportProbes({ ...PARAMS, wantActiveCameras: true });
  assert.equal(got, null);
});

test("body không phải JSON → null, không nổ", async () => {
  stubFetch(() => new Response("<html>504 gateway timeout</html>", { status: 200 }));

  const got = await reportProbes({ ...PARAMS, wantActiveCameras: true });
  assert.equal(got, null);
});

test("không có probe nào thì không gọi mạng", async () => {
  const calls = stubFetch(() => jsonResponse({ ok: true }));

  const got = await reportProbes({ ...PARAMS, probes: [], wantActiveCameras: true });

  assert.equal(got, null);
  assert.equal(calls.length, 0);
});
