import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEAL_AFTER_CONSECUTIVE_FAILS,
  HEAL_COOLDOWN_MS,
  pickHealedIp,
  shouldAttemptHeal,
  slash24Of,
  healCameraIp,
  MAX_HEAL_SUBNETS,
  type HealCandidate,
} from "../src/camera-heal";
import type { DiscoveredDevice } from "../src/lan-discovery";

const CANDIDATE: HealCandidate = {
  cameraId: "11111111-1111-4111-8111-111111111111",
  cameraCode: "hik_3",
  ip: "192.168.31.135",
  macAddress: "44:47:CC:11:22:33",
  consecutiveFails: HEAL_AFTER_CONSECUTIVE_FAILS,
};

function device(ip: string, mac: string | null): DiscoveredDevice {
  return {
    ip,
    open_ports: [554],
    rtsp_port: 554,
    web_ports: [],
    onvif_detected: false,
    mac_address: mac,
    onvif_xaddr: null,
    vendor: null,
    model: null,
    confidence: "likely_camera",
    suggested_rtsp_paths: [],
    subnet: "192.168.31.0/24",
  };
}

test("chưa đủ số lần hỏng thì không quét", () => {
  assert.equal(
    shouldAttemptHeal({
      candidate: { ...CANDIDATE, consecutiveFails: HEAL_AFTER_CONSECUTIVE_FAILS - 1 },
      lastAttemptAtMs: null,
      nowMs: 1_000,
    }),
    false,
  );
});

test("camera chưa có MAC thì không bao giờ tự chữa", () => {
  assert.equal(
    shouldAttemptHeal({
      candidate: { ...CANDIDATE, macAddress: null, consecutiveFails: 99 },
      lastAttemptAtMs: null,
      nowMs: 1_000,
    }),
    false,
  );
});

test("tôn trọng thời gian chờ giữa hai lần quét", () => {
  const now = 10_000_000;
  assert.equal(
    shouldAttemptHeal({ candidate: CANDIDATE, lastAttemptAtMs: now - 1_000, nowMs: now }),
    false,
  );
  assert.equal(
    shouldAttemptHeal({
      candidate: CANDIDATE,
      lastAttemptAtMs: now - HEAL_COOLDOWN_MS,
      nowMs: now,
    }),
    true,
  );
});

test("tính đúng subnet /24", () => {
  assert.equal(slash24Of("192.168.31.135"), "192.168.31.0/24");
  assert.equal(slash24Of("10.0.0.7"), "10.0.0.0/24");
  assert.equal(slash24Of("không phải ip"), null);
  assert.equal(slash24Of("999.1.1.1"), null);
});

test("khớp MAC thì trả IP mới", () => {
  const found = pickHealedIp(
    [device("192.168.31.20", "44:47:CC:11:22:33"), device("192.168.31.21", "AA:BB:CC:DD:EE:FF")],
    { macAddress: "44:47:CC:11:22:33", currentIp: "192.168.31.135" },
  );
  assert.equal(found, "192.168.31.20");
});

test("MAC viết kiểu khác vẫn khớp", () => {
  const found = pickHealedIp([device("192.168.31.20", "44-47-cc-11-22-33")], {
    macAddress: "44:47:CC:11:22:33",
    currentIp: "192.168.31.135",
  });
  assert.equal(found, "192.168.31.20");
});

test("IP không đổi thì không báo gì", () => {
  const found = pickHealedIp([device("192.168.31.135", "44:47:CC:11:22:33")], {
    macAddress: "44:47:CC:11:22:33",
    currentIp: "192.168.31.135",
  });
  assert.equal(found, null);
});

test("hai thiết bị cùng MAC thì từ chối chữa, thà không chữa còn hơn chữa sai", () => {
  const found = pickHealedIp(
    [device("192.168.31.20", "44:47:CC:11:22:33"), device("192.168.31.21", "44:47:CC:11:22:33")],
    { macAddress: "44:47:CC:11:22:33", currentIp: "192.168.31.135" },
  );
  assert.equal(found, null);
});

test("không thấy MAC nào khớp thì trả null", () => {
  const found = pickHealedIp([device("192.168.31.20", "AA:BB:CC:DD:EE:FF")], {
    macAddress: "44:47:CC:11:22:33",
    currentIp: "192.168.31.135",
  });
  assert.equal(found, null);
});

test("thiết bị không lấy được MAC không bao giờ bị nhận nhầm", () => {
  const found = pickHealedIp([device("192.168.31.20", null)], {
    macAddress: "44:47:CC:11:22:33",
    currentIp: "192.168.31.135",
  });
  assert.equal(found, null);
});

// ---------------------------------------------------------------------------
// Thứ tự tìm kiếm: bảng ARP trước, quét cổng chỉ là dự phòng.
//
// Vì sao khoá lại bằng test: ngày 16/09 chạy thật trên LAN kho, lần quét
// lúc agent đang bận chỉ thấy 3 thiết bị (2 MAC) trong khi lúc rảnh thấy 7
// thiết bị (6 MAC) — camera cần tìm rơi mất và việc tự chữa thất bại, dù
// bảng ARP lúc đó đã có sẵn đúng IP.
// ---------------------------------------------------------------------------

const HEAL_DEPS = {
  backendUrl: "https://vi-du.invalid",
  agentCode: "AGENT_TEST",
  agentSecret: "secret-test",
};

/** Đếm số lần quét để chứng minh có gọi hay không. */
function scanSpy(devices: DiscoveredDevice[]) {
  const calls: number[] = [];
  const scan = async () => {
    calls.push(Date.now());
    return { devices, subnets: [], duration_ms: 1 };
  };
  return { scan: scan as never, calls };
}

test("thấy MAC trong bảng ARP thì không quét cổng nữa", async () => {
  const spy = scanSpy([]);
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as never;
  try {
    const result = await healCameraIp({
      ...HEAL_DEPS,
      candidate: { ...CANDIDATE, ip: "192.168.31.250" },
      scan: spy.scan,
      findIpByMac: async () => "192.168.31.135",
      checkRtsp: async () => ({ ok: true, latencyMs: 4 }),
    });
    assert.deepEqual(result, {
      cameraId: CANDIDATE.cameraId,
      previousIp: "192.168.31.250",
      newIp: "192.168.31.135",
    });
    assert.equal(spy.calls.length, 0, "không được quét khi ARP đã trả lời");
    assert.equal(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ARP chưa biết IP mới thì mới quét", async () => {
  const spy = scanSpy([device("192.168.31.77", CANDIDATE.macAddress!)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never;
  try {
    const result = await healCameraIp({
      ...HEAL_DEPS,
      candidate: { ...CANDIDATE, ip: "192.168.31.250" },
      scan: spy.scan,
      findIpByMac: async () => null,
      checkRtsp: async () => ({ ok: true, latencyMs: 4 }),
    });
    assert.equal(result?.newIp, "192.168.31.77");
    assert.equal(spy.calls.length, 1, "ARP không biết thì phải quét");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("IP khớp MAC nhưng không mở RTSP thì không báo cloud", async () => {
  const spy = scanSpy([]);
  let posted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    posted = true;
    return new Response("{}", { status: 200 });
  }) as never;
  try {
    const result = await healCameraIp({
      ...HEAL_DEPS,
      candidate: { ...CANDIDATE, ip: "192.168.31.250" },
      scan: spy.scan,
      findIpByMac: async () => "192.168.31.135",
      checkRtsp: async () => ({ ok: false, latencyMs: null }),
    });
    assert.equal(result, null);
    assert.equal(posted, false, "chưa xác nhận RTSP thì tuyệt đối không báo cloud");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Đổi mạng: cài ở wifi này, chạy ở wifi khác. Camera nhận IP ở dải hoàn
// toàn mới, nên tìm theo subnet cũ là không bao giờ thấy. MAC đã lưu trong
// database từ lần đăng nhập đầu, và đó là thứ duy nhất không đổi.
// ---------------------------------------------------------------------------

/** Ghi lại các subnet đã quét để kiểm thứ tự và số lượng. */
function scanRecorder(byCidr: Record<string, DiscoveredDevice[]>) {
  const scanned: string[] = [];
  const scan = async (opts: { cidr: string }) => {
    scanned.push(opts.cidr);
    return { devices: byCidr[opts.cidr] ?? [], subnets: [], duration_ms: 1 };
  };
  return { scan: scan as never, scanned };
}

const localSubnets = (...cidrs: string[]) =>
  (() =>
    cidrs.map((cidr) => ({
      cidr,
      interface_name: "Wi-Fi",
      is_virtual: false,
    }))) as never;

test("camera sang mạng khác: ARP biết thì chữa ngay, không cần quét", async () => {
  const spy = scanRecorder({});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never;
  try {
    const result = await healCameraIp({
      ...HEAL_DEPS,
      candidate: { ...CANDIDATE, ip: "192.168.1.50" }, // IP cũ ở wifi 1
      scan: spy.scan,
      listSubnets: localSubnets("192.168.31.0/24"),
      findIpByMac: async () => "192.168.31.77", // wifi 2
      checkRtsp: async () => ({ ok: true, latencyMs: 5 }),
    });
    assert.equal(result?.newIp, "192.168.31.77");
    assert.deepEqual(spy.scanned, [], "ARP đã trả lời thì không được quét");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ARP chưa biết thì quét subnet cũ trước, rồi tới mạng máy đang nối", async () => {
  const spy = scanRecorder({
    "192.168.31.0/24": [device("192.168.31.77", CANDIDATE.macAddress!)],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never;
  try {
    const result = await healCameraIp({
      ...HEAL_DEPS,
      candidate: { ...CANDIDATE, ip: "192.168.1.50" },
      scan: spy.scan,
      listSubnets: localSubnets("192.168.31.0/24"),
      findIpByMac: async () => null,
      checkRtsp: async () => ({ ok: true, latencyMs: 5 }),
    });
    assert.equal(result?.newIp, "192.168.31.77");
    assert.deepEqual(spy.scanned, ["192.168.1.0/24", "192.168.31.0/24"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("không quét quá số subnet cho phép, dù máy nối nhiều mạng", async () => {
  const spy = scanRecorder({});
  const result = await healCameraIp({
    ...HEAL_DEPS,
    candidate: { ...CANDIDATE, ip: "192.168.1.50" },
    scan: spy.scan,
    listSubnets: localSubnets(
      "192.168.31.0/24",
      "10.0.0.0/24",
      "172.16.5.0/24",
      "192.168.99.0/24",
    ),
    findIpByMac: async () => null,
    checkRtsp: async () => ({ ok: true, latencyMs: 5 }),
  });
  assert.equal(result, null);
  assert.equal(
    spy.scanned.length,
    MAX_HEAL_SUBNETS,
    "mỗi lần quét /24 mở 254 kết nối trên máy đang ghi hình — phải có trần",
  );
});

test("IP cũ không thuộc mạng nào máy đang nối thì chữa ngay từ nhịp hỏng đầu", () => {
  const ok = shouldAttemptHeal({
    candidate: { ...CANDIDATE, consecutiveFails: 1, outsideLocalSubnets: true },
    lastAttemptAtMs: null,
    nowMs: Date.now(),
  });
  assert.equal(ok, true, "chờ thêm hai nhịp chỉ kéo dài thời gian bàn không có hình");
});

test("cùng mạng thì vẫn phải đủ ba nhịp hỏng mới chữa", () => {
  const ok = shouldAttemptHeal({
    candidate: { ...CANDIDATE, consecutiveFails: 1, outsideLocalSubnets: false },
    lastAttemptAtMs: null,
    nowMs: Date.now(),
  });
  assert.equal(ok, false, "một nhịp hỏng trong cùng mạng có thể chỉ là nhiễu");
});
