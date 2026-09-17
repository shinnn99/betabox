import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDiscoveringAgent } from "@/lib/camera/discovering-agent";

/**
 * Agent nào phục vụ camera vừa đăng nhập.
 *
 * Nguồn sự thật là kết quả quét LAN: agent chỉ với tới được camera cùng
 * mạng với máy nó chạy. Sai ở đây nghĩa là camera nằm với một agent không
 * bao giờ kết nối được — hoặc tệ hơn, không agent nào, và màn hình giám sát
 * trống mà không báo gì (camera EZVIZ CAM_TEST, 17/09/2026).
 */

const EZVIZ = { ip: "192.168.31.58", mac_address: "90:31:4B:22:FA:49" };
const scan = (agent_id: string, devices: Array<{ ip: string; mac_address?: string | null }>) => ({
  agent_id,
  result: { devices },
});

test("agent đã quét thấy MAC của camera thì nhận camera", () => {
  const agent = pickDiscoveringAgent({
    discoveries: [scan("kho-hn", [{ ip: "192.168.31.58", mac_address: "90:31:4b:22:fa:49" }])],
    camera: EZVIZ,
    activeAgentIds: ["kho-hn", "kho-dai-kim"],
  });
  assert.equal(agent, "kho-hn");
});

test("camera đổi mạng: lấy lần quét MỚI NHẤT, không lấy máy cũ", () => {
  const agent = pickDiscoveringAgent({
    // Xếp mới nhất trước, đúng như câu truy vấn thật.
    discoveries: [
      scan("may-wifi-2", [{ ip: "10.0.0.20", mac_address: "90:31:4B:22:FA:49" }]),
      scan("may-wifi-1", [{ ip: "192.168.31.58", mac_address: "90:31:4B:22:FA:49" }]),
    ],
    camera: EZVIZ,
    activeAgentIds: ["may-wifi-1", "may-wifi-2"],
  });
  assert.equal(agent, "may-wifi-2");
});

test("khớp MAC được ưu tiên hơn khớp IP", () => {
  // IP .58 ở lần quét này là một thiết bị KHÁC (MAC khác) — DHCP đã cấp lại.
  const agent = pickDiscoveringAgent({
    discoveries: [
      scan("may-sai", [{ ip: "192.168.31.58", mac_address: "AA:BB:CC:DD:EE:FF" }]),
      scan("may-dung", [{ ip: "192.168.31.99", mac_address: "90:31:4B:22:FA:49" }]),
    ],
    camera: EZVIZ,
    activeAgentIds: ["may-sai", "may-dung"],
  });
  assert.equal(agent, "may-dung");
});

test("quét không lấy được MAC thì mới rơi xuống khớp theo IP", () => {
  const agent = pickDiscoveringAgent({
    discoveries: [scan("kho-hn", [{ ip: "192.168.31.58", mac_address: null }])],
    camera: EZVIZ,
    activeAgentIds: ["kho-hn", "kho-dai-kim"],
  });
  assert.equal(agent, "kho-hn");
});

test("chưa quét lần nào nhưng tổ chức chỉ có một agent thì giao cho nó", () => {
  const agent = pickDiscoveringAgent({
    discoveries: [],
    camera: { ip: "192.168.31.58", mac_address: null },
    activeAgentIds: ["kho-hn"],
  });
  assert.equal(agent, "kho-hn");
});

test("nhiều agent mà không lần quét nào thấy camera thì KHÔNG đoán", () => {
  const agent = pickDiscoveringAgent({
    discoveries: [],
    camera: EZVIZ,
    activeAgentIds: ["kho-hn", "kho-dai-kim"],
  });
  assert.equal(
    agent,
    null,
    "giao nhầm cho máy ở kho khác thì camera không bao giờ kết nối được",
  );
});
