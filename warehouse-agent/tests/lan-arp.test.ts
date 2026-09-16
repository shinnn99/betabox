import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countDistinctHostsPerMac,
  dropAmbiguousMacs,
  findIpByMac,
  normalizeMac,
  parseArpTable,
  resolveMacAddresses,
} from "../src/lan-arp";

const WINDOWS_ARP = `
Interface: 192.168.31.10 --- 0x11
  Internet Address      Physical Address      Type
  192.168.31.1          a4-2b-b0-11-22-33     dynamic
  192.168.31.12         bc-32-5f-aa-bb-cc     dynamic
  192.168.31.135        44-47-cc-11-22-33     dynamic
  192.168.31.255        ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
`;

test("bóc được IP và MAC từ output arp -a của Windows", () => {
  const table = parseArpTable(WINDOWS_ARP);
  assert.equal(table.get("192.168.31.12"), "BC:32:5F:AA:BB:CC");
  assert.equal(table.get("192.168.31.135"), "44:47:CC:11:22:33");
  assert.equal(table.get("192.168.31.1"), "A4:2B:B0:11:22:33");
});

test("bỏ broadcast và multicast, không coi là thiết bị", () => {
  const table = parseArpTable(WINDOWS_ARP);
  assert.equal(table.has("192.168.31.255"), false);
  assert.equal(table.has("224.0.0.22"), false);
});

test("đọc được cả định dạng arp của Unix", () => {
  const table = parseArpTable("? (10.0.0.5) at 00:1a:2b:3c:4d:5e [ether] on eth0");
  assert.equal(table.get("10.0.0.5"), "00:1A:2B:3C:4D:5E");
});

test("chuẩn hoá MAC về chữ hoa, ngăn bằng dấu hai chấm", () => {
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("AABB.CCDD.EEFF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("00:00:00:00:00:00"), null);
  assert.equal(normalizeMac("quá ngắn"), null);
  assert.equal(normalizeMac(null), null);
});

test("một MAC ứng nhiều IP bị loại — đó là MAC của router, không phải camera", () => {
  const table = new Map([
    ["192.168.31.12", "BC:32:5F:AA:BB:CC"],
    ["10.10.0.7", "A4:2B:B0:11:22:33"],
    ["10.10.0.8", "A4:2B:B0:11:22:33"],
  ]);
  assert.equal(countDistinctHostsPerMac(table).get("A4:2B:B0:11:22:33"), 2);
  const cleaned = dropAmbiguousMacs(table);
  assert.equal(cleaned.get("192.168.31.12"), "BC:32:5F:AA:BB:CC");
  assert.equal(cleaned.has("10.10.0.7"), false);
  assert.equal(cleaned.has("10.10.0.8"), false);
});

test("chỉ trả MAC cho IP được hỏi, và chạm vào từng IP trước khi đọc bảng", async () => {
  const touched: string[] = [];
  const result = await resolveMacAddresses(["192.168.31.12", "192.168.31.99"], {
    touch: async (ip) => {
      touched.push(ip);
    },
    readArpTable: async () => parseArpTable(WINDOWS_ARP),
  });
  assert.deepEqual(touched, ["192.168.31.12", "192.168.31.99"]);
  assert.equal(result.get("192.168.31.12"), "BC:32:5F:AA:BB:CC");
  // .99 không có trong bảng ARP → vắng mặt, KHÔNG phải lỗi.
  assert.equal(result.has("192.168.31.99"), false);
  // .135 có trong bảng nhưng không được hỏi → không trả về.
  assert.equal(result.has("192.168.31.135"), false);
});

test("bảng ARP đọc lỗi thì trả rỗng chứ không ném", async () => {
  const result = await resolveMacAddresses(["192.168.31.12"], {
    touch: async () => {},
    readArpTable: async () => new Map(),
  });
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// Tra thẳng MAC → IP trong bảng ARP. Đây là đường tìm kiếm chính khi camera
// đổi IP, vì nó không phụ thuộc vào việc quét cổng có kịp trong 1 giây hay
// không.
// ---------------------------------------------------------------------------

const arpTable = (entries: Record<string, string>) => async () =>
  new Map(Object.entries(entries));

test("tìm được IP của MAC trong đúng subnet", async () => {
  const ip = await findIpByMac("8c:22:d2:6c:7f:19", {
    subnetPrefix: "192.168.31.",
    readArpTable: arpTable({
      "192.168.31.12": "08:ED:ED:9F:DB:97",
      "192.168.31.135": "8C:22:D2:6C:7F:19",
    }),
  });
  assert.equal(ip, "192.168.31.135");
});

test("bỏ qua IP ngoài subnet đang xét", async () => {
  const ip = await findIpByMac("8C:22:D2:6C:7F:19", {
    subnetPrefix: "192.168.31.",
    readArpTable: arpTable({ "10.0.0.5": "8C:22:D2:6C:7F:19" }),
  });
  assert.equal(ip, null);
});

test("MAC ứng nhiều IP thì không đoán bừa", async () => {
  const ip = await findIpByMac("8C:22:D2:6C:7F:19", {
    subnetPrefix: "192.168.31.",
    readArpTable: arpTable({
      "192.168.31.135": "8C:22:D2:6C:7F:19",
      "192.168.31.200": "8C:22:D2:6C:7F:19",
    }),
  });
  assert.equal(ip, null);
});
