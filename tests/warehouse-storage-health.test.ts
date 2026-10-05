import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildStorageWarnings,
  capacityDaysOf,
  readStorageHealth,
  type AgentDiskView,
} from "../src/lib/warehouse/storage-health.ts";

/**
 * Sức chứa bằng chứng của kho (/dashboard/storage).
 *
 * Số thật dùng làm ca kiểm lấy từ kho Đại Kim ngày 02/10/2026: ổ 465 GB, còn
 * trống 45.9 GB, ghi ~39.9 GB/ngày, `retention_days` đặt 30. Tức cấu hình hứa
 * 30 ngày trong khi ổ chỉ chứa nổi ~11.7 ngày — đúng cái lệch mà trang này
 * sinh ra để phát hiện.
 */

const GB = 1024 ** 3;

function agent(over: Partial<AgentDiskView> = {}): AgentDiskView {
  return {
    agentId: "a1",
    code: "AGENT_KHO_DAI_KIM",
    name: null,
    online: true,
    lastSeenAt: new Date().toISOString(),
    reportAt: new Date().toISOString(),
    disk: {
      freeBytes: 45.9 * GB,
      totalBytes: 465 * GB,
      usedBytes: (465 - 45.9) * GB,
      recordingBytes: 350 * GB,
      freePct: 9.9,
      bytesPerDay: 39.9 * GB,
      daysLeft: 1.1,
      capacityDays: 11.6,
    },
    ...over,
  };
}

test("số thật Đại Kim: ổ 465 GB, ghi 39.9 GB/ngày → chứa ~11.6 ngày", () => {
  const days = capacityDaysOf(465 * GB, 39.9 * GB);
  assert.ok(days !== null && days > 11 && days < 12, `thực tế: ${days}`);
});

test("chưa biết tốc độ ghi → KHÔNG bịa sức chứa", () => {
  assert.equal(capacityDaysOf(465 * GB, null), null);
  assert.equal(capacityDaysOf(465 * GB, 0), null, "chia cho 0 phải trả null, không Infinity");
});

test("đặt giữ 30 ngày mà ổ chỉ đủ 11.6 → phải cảnh báo lệch cấu hình", () => {
  const w = buildStorageWarnings([agent()], 30);
  const hit = w.find((x) => x.kind === "retention_exceeds_capacity");
  assert.ok(hit, `phải có cảnh báo lệch; thực tế: ${JSON.stringify(w.map((x) => x.kind))}`);
  assert.match(hit.message, /30/);
  assert.match(hit.message, /11\.6/);
});

test("cảnh báo lệch nói rõ LỆCH BAO NHIÊU ngày, không chỉ 'không đủ'", () => {
  // 30 − 11.6 = 18.4. Con số này buộc người đọc đối chiếu được; câu "không
  // đủ" thì đọc xong vẫn không biết có nghiêm trọng không.
  const hit = buildStorageWarnings([agent()], 30).find(
    (x) => x.kind === "retention_exceeds_capacity",
  );
  assert.ok(hit);
  assert.match(hit.message, /18\.4 ngày/, `thực tế: ${hit.message}`);
});

test("cảnh báo ổ đầy nêu cả đã dùng lẫn tổng dung lượng", () => {
  const hit = buildStorageWarnings([agent()], 30).find((x) => x.kind === "disk_full_soon");
  assert.ok(hit);
  assert.match(hit.message, /419\.1 GB \/ 465\.0 GB/, `thực tế: ${hit.message}`);
});

test("ổ còn 1.1 ngày → cảnh báo mức nghiêm trọng, và nói rõ hậu quả NGỪNG GHI", () => {
  const w = buildStorageWarnings([agent()], 30);
  const hit = w.find((x) => x.kind === "disk_full_soon");
  assert.ok(hit);
  assert.equal(hit.severity, "crit", "dưới 3 ngày phải là crit");
  assert.match(hit.action, /NGỪNG GHI/, "phải nói hậu quả thật, không chỉ 'ổ sắp đầy'");
});

test("cảnh báo nặng xếp trước nhẹ", () => {
  const w = buildStorageWarnings([agent()], 30);
  assert.ok(w.length >= 2);
  assert.equal(w[0].severity, "crit", `thực tế thứ tự: ${w.map((x) => x.severity).join(",")}`);
});

test("ổ rộng rãi + cấu hình khớp → KHÔNG cảnh báo gì", () => {
  const roomy = agent({
    disk: {
      freeBytes: 400 * GB,
      totalBytes: 465 * GB,
      usedBytes: 65 * GB,
      recordingBytes: 50 * GB,
      freePct: 86,
      bytesPerDay: 10 * GB,
      daysLeft: 40,
      capacityDays: 46.5,
    },
  });
  assert.deepEqual(buildStorageWarnings([roomy], 30), []);
});

test("lệch nhỏ (ổ 26 ngày vs đặt 30) KHÔNG kêu — chỉ kêu khi lệch rõ", () => {
  const near = agent({
    disk: {
      freeBytes: 200 * GB,
      totalBytes: 465 * GB,
      usedBytes: 265 * GB,
      recordingBytes: 230 * GB,
      freePct: 43,
      bytesPerDay: 18 * GB,
      daysLeft: 11,
      capacityDays: 26,
    },
  });
  const w = buildStorageWarnings([near], 30);
  assert.equal(
    w.filter((x) => x.kind === "retention_exceeds_capacity").length,
    0,
    "26/30 = 87% ngưỡng 80% → không được kêu, tránh báo động giả vì sai số đo",
  );
});

test("máy bản cũ chưa tự khai → nói chưa biết, KHÔNG coi là ổ trống", () => {
  const w = buildStorageWarnings([agent({ disk: null })], 30);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "no_self_report");
  assert.equal(
    w.filter((x) => x.kind === "disk_full_soon").length,
    0,
    "không có số liệu thì KHÔNG được suy ra ổ sắp đầy",
  );
});

test("retention chưa đặt (null) → không cảnh báo lệch cấu hình", () => {
  const w = buildStorageWarnings([agent()], null);
  assert.equal(w.filter((x) => x.kind === "retention_exceeds_capacity").length, 0);
});

test("agent mất kết nối → nói rõ số liệu là lần báo cuối", () => {
  const w = buildStorageWarnings([agent({ online: false })], 30);
  const hit = w.find((x) => x.kind === "agent_offline");
  assert.ok(hit);
  assert.match(hit.message, /lần báo cuối/);
});

/* ---------------------------------------------------------------------------
 * Hồi quy: dung lượng theo ngày phải GỘP Ở SQL.
 *
 * Bug thật 02/10/2026: bản đầu kéo thẳng `camera_recording_files` về Node kèm
 * ghi chú "tập nhỏ". Kho Đại Kim có 11.158 dòng/14 ngày; PostgREST chặn 1.000
 * dòng nên trang chỉ nhận 1.000 dòng CŨ NHẤT → vẽ đúng 2 ngày, tổng hiện "1000
 * video / 7.3 GB". Nhìn như kho ngừng hoạt động trong khi kho chạy đủ 13 ngày.
 *
 * Khoá hai điều: (1) phải gọi RPC chứ không select bảng thô; (2) số ngày trả
 * về không bị trần 1.000 dòng chặn.
 * ------------------------------------------------------------------------- */

function fakeHealthAdmin(calls: { rpcs: string[]; tables: string[] }, days: number) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    gte: () => q,
    not: () => q,
    maybeSingle: async () => ({ data: { retention_days: 30 }, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  };
  return {
    rpc: async (name: string) => {
      calls.rpcs.push(name);
      if (name !== "recording_daily_usage") return { data: [], error: null };
      // 13 ngày, mỗi ngày ~1.100 đoạn — tổng vượt xa trần 1.000 dòng.
      return {
        data: Array.from({ length: days }, (_, i) => ({
          day: `2026-09-${String(18 + i).padStart(2, "0")}`,
          segments: 1100,
          bytes: 33_000_000_000,
          segments_without_size: 0,
          segments_recording: 0,
        })),
        error: null,
      };
    },
    from: (t: string) => {
      calls.tables.push(t);
      return q;
    },
  };
}

test("hồi quy: ngày lấy qua RPC gộp, KHÔNG select camera_recording_files thô", async () => {
  const calls = { rpcs: [] as string[], tables: [] as string[] };
  const health = await readStorageHealth(fakeHealthAdmin(calls, 13) as never, "org-1");

  assert.ok(
    calls.rpcs.includes("recording_daily_usage"),
    `phải gọi RPC gộp; thực tế gọi: ${JSON.stringify(calls.rpcs)}`,
  );
  assert.equal(
    calls.tables.filter((t) => t === "camera_recording_files").length,
    0,
    "KHÔNG được select bảng thô — đó chính là đường dính trần 1.000 dòng",
  );
  assert.equal(health.daily.length, 13, "phải đủ 13 ngày, không bị cắt còn 2");
  assert.equal(
    health.daily.reduce((n, d) => n + d.segments, 0),
    14_300,
    "tổng số video phải vượt được mốc 1.000 — số 1.000 tròn trĩnh là dấu hiệu chạm trần",
  );
});

test("đoạn ĐANG QUAY không bị đếm thành 'thiếu dung lượng'", async () => {
  // Bug thật 02/10/2026: ngày hôm nay có 2 đoạn ended_at NULL (đang quay, bắt
  // đầu chưa tới 1 phút trước) bị gộp chung với đoạn agent bản cũ, nên cột
  // 02/10 tô hổ phách kèm nhãn "máy kho bản cũ" — cảnh báo sai mỗi ngày.
  const calls = { rpcs: [] as string[], tables: [] as string[] };
  const admin = {
    rpc: async (name: string) => {
      calls.rpcs.push(name);
      if (name !== "recording_daily_usage") return { data: [], error: null };
      return {
        data: [
          // Hôm nay: chỉ có đoạn đang quay.
          { day: "2026-10-02", segments: 781, bytes: 22e9, segments_without_size: 0, segments_recording: 2 },
          // Ngày agent bản cũ: thiếu thật, đã đóng file.
          { day: "2026-09-19", segments: 1038, bytes: 8e9, segments_without_size: 519, segments_recording: 0 },
        ],
        error: null,
      };
    },
    from: (t: string) => {
      calls.tables.push(t);
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, gte: () => q, not: () => q,
        maybeSingle: async () => ({ data: { retention_days: 30 }, error: null }),
        then: (r: (v: unknown) => void) => r({ data: [], error: null }),
      };
      return q;
    },
  };
  const health = await readStorageHealth(admin as never, "org-1");

  const today = health.daily.find((d) => d.day === "2026-10-02");
  assert.ok(today);
  assert.equal(today.segmentsWithoutSize, 0, "đang quay KHÔNG phải thiếu dung lượng");
  assert.equal(today.segmentsRecording, 2);

  const oldAgentDay = health.daily.find((d) => d.day === "2026-09-19");
  assert.ok(oldAgentDay);
  assert.equal(oldAgentDay.segmentsWithoutSize, 519, "agent bản cũ vẫn phải bị đếm là thiếu");
  assert.equal(oldAgentDay.segmentsRecording, 0);
});

test("API kho giữ riêng dung lượng toàn ổ và dung lượng thư mục video", async () => {
  const reportAt = "2026-10-02T08:00:00.000Z";
  const agentRow = {
    id: "agent-1",
    code: "KHO-1",
    name: "Máy kho 1",
    organization_id: "org-1",
    status: "active",
    last_seen_at: new Date().toISOString(),
    self_report_at: reportAt,
    agent_version: "0.13.2",
    self_report: {
      version: "0.13.2",
      cameras: [],
      queues: {},
      capabilities: [],
      disk: {
        free_bytes: 100 * GB,
        total_bytes: 500 * GB,
        bytes_per_day: 20 * GB,
        recording_bytes: 275 * GB,
      },
    },
  };

  const admin = {
    rpc: async () => ({ data: [], error: null }),
    from: (table: string) => {
      if (table === "warehouse_agents") {
        const q: Record<string, unknown> = {
          select: () => q,
          in: () => q,
          order: async () => ({ data: [agentRow], error: null }),
        };
        return q;
      }
      if (table === "organizations") {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: { retention_days: 30 }, error: null }),
        };
        return q;
      }
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        not: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return q;
    },
  };

  const health = await readStorageHealth(admin as never, "org-1");
  assert.equal(health.agents.length, 1);
  assert.equal(health.agents[0].disk?.usedBytes, 400 * GB, "toàn ổ đã dùng");
  assert.equal(health.agents[0].disk?.recordingBytes, 275 * GB, "riêng RECORDING_DIR");
  assert.equal(health.agents[0].reportAt, reportAt);
});

test("giao diện theo dõi đồng thời tổng ổ và riêng thư mục lưu video", () => {
  const page = readFileSync("src/app/dashboard/storage/page.tsx", "utf8");
  assert.ok(page.includes("Tổng ổ đĩa &amp; thư mục video"));
  assert.ok(page.includes("disk.recordingBytes"));
  assert.ok(page.includes("Dữ liệu khác trên ổ"));
  assert.ok(page.includes("Máy kho hiện mới báo tổng ổ"), "agent cũ phải hiện là chưa có số riêng");
});
