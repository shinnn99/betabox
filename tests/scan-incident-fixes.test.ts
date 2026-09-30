import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./read-source";
import { findSameDayOutboundOrder, vnBusinessDate, vnClock } from "@/lib/warehouse/same-day-order";
import { describeOrphanScan, ORPHAN_PENDING_MS } from "@/lib/warehouse/live/activity";
import {
  OPEN_SEGMENT_CLOSE_GRACE_SECONDS,
  evaluateOpenSegments,
} from "@/lib/order-proof/open-segment-verdict";
import { withEstimatedEnds, type SegmentFile } from "@/lib/order-proof/clip-resolver";
import { isTransientSegmentFailure } from "@/lib/order-proof/transient-failure";
import { BASE_VIDEO_KBPS, MIN_VIDEO_KBPS, SIZE_HEADROOM, reencodeKbpsFor, reencodedBytes } from "@/lib/order-proof/compose-bitrate";
import { applyRefitToFit, estimateCompositeProofSize, estimateProofSize } from "@/lib/order-proof/proof-size-estimate";
import { computeFinalizedClipWindow } from "@/lib/order-proof/clip-window";
import { checkCameraProbe, type MonitoringScope } from "@/lib/system/checks";

/**
 * Lỗi chủ dự án gửi ảnh ngày 26/09/2026 (kho Đại Kim):
 *   - thời gian đóng đơn ÂM, clip chồng lên nhau — lượt quét tới muộn, ngược thứ tự
 *   - "Mã sai / Đang chờ xử lý" cho lượt quét lại một mã đã có đơn
 *   - "Segment cuối chưa đóng" thành lỗi vĩnh viễn — có segment mà không cắt được
 *   - "Proof có nguy cơ vượt giới hạn ~130 MiB" ở gần như mọi đơn (báo nhầm)
 *   - camera dahua_01 đã tháo vẫn "cập nhật mấy chục giây trước" và giữ sự cố mở
 */

const MiB = 1024 * 1024;
const GUARD = 90 * MiB;
const WARN = 80 * MiB;

// ── Mã trùng: báo trùng, không lưu ─────────────────────────────────────

test("ngày làm việc theo giờ Việt Nam (UTC+7)", () => {
  assert.equal(vnBusinessDate("2026-09-26T16:59:59Z"), "2026-09-26");
  assert.equal(vnBusinessDate("2026-09-26T17:00:00Z"), "2026-09-27");
  assert.equal(vnClock("2026-09-26T02:17:15Z"), "09:17:15");
});

test("tìm đơn cùng ngày: đúng tiêu chí trùng của RPC (mã viết hoa, outbound, valid/duplicated)", async () => {
  const seen: Array<[string, unknown]> = [];
  const admin = {
    from() {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => (seen.push([c, v]), q);
      q.in = (c: string, v: unknown) => (seen.push([c, v]), q);
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => ({ data: { id: "pe-1", scanned_at: "2026-09-26T02:17:15Z" }, error: null });
      return q;
    },
  } as never;
  const r = await findSameDayOutboundOrder(admin, {
    organizationId: "org",
    waybillCode: "  spxvn060308984969 ",
    scannedAt: "2026-09-26T02:18:53Z",
  });
  assert.equal(r?.id, "pe-1");
  assert.deepEqual(seen, [
    ["organization_id", "org"],
    ["waybill_code", "SPXVN060308984969"],
    ["business_date", "2026-09-26"],
    ["event_kind", "outbound"],
    ["status", ["valid", "duplicated"]],
  ]);
});

test("tìm đơn cùng ngày: đọc lỗi → coi như chưa có (thà lưu thừa còn hơn nuốt đơn thật)", async () => {
  const admin = {
    from() {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: { message: "timeout" } });
      return q;
    },
  } as never;
  assert.equal(await findSameDayOutboundOrder(admin, { organizationId: "o", waybillCode: "X", scannedAt: "2026-09-26T00:00:00Z" }), null);
});

test("route quét: mã trùng từ nguồn đang tắt → báo trùng và dừng TRƯỚC khi ghi lượt quét thô", () => {
  const src = readSource("src/app/api/warehouse/scans/route.ts");
  const dup = src.indexOf('if (scanSourceDisabled && scanType === "waybill") {');
  const insert = src.indexOf('admin.from("warehouse_scan_raw_events").insert(row)');
  assert.ok(dup > 0 && insert > dup, "nhánh trùng phải đứng trước câu ghi lượt quét thô");
  assert.ok(src.includes('ignored: "duplicate",'));
  assert.ok(src.includes('code: "duplicate_scan",'));
});

// ── Nhật ký: nhãn cho lượt quét mồ côi ─────────────────────────────────

test("mồ côi mà mã đã có đơn → 'Trùng', dù bị bỏ vì nguồn quét hay không", () => {
  const a = describeOrphanScan({ isStaff: false, ignoredReason: null, source: "serial", alreadyOrdered: true, ageMs: 10_000 });
  assert.equal(a.kind, "waybill_duplicated");
  assert.match(a.note, /không tính/);
  const b = describeOrphanScan({ isStaff: false, ignoredReason: "scan_source_disabled", source: "serial", alreadyOrdered: true, ageMs: 10_000 });
  assert.equal(b.kind, "waybill_duplicated");
  assert.match(b.note, /nguồn quét này đang tắt/);
});

test("mồ côi chưa có đơn: có lý do → nói lý do; mới tới → đang chờ; cũ không lý do → 'Không tạo đơn', không bao giờ 'Mã sai'", () => {
  assert.equal(
    describeOrphanScan({ isStaff: false, ignoredReason: "scan_source_disabled", source: "serial", alreadyOrdered: false, ageMs: 1 }).kind,
    "waybill_source_disabled",
  );
  const fresh = describeOrphanScan({ isStaff: false, ignoredReason: null, source: "camera_qr", alreadyOrdered: false, ageMs: ORPHAN_PENDING_MS - 1 });
  assert.equal(fresh.note, "Đang chờ xử lý");
  const old = describeOrphanScan({ isStaff: false, ignoredReason: null, source: "camera_qr", alreadyOrdered: false, ageMs: ORPHAN_PENDING_MS + 1 });
  assert.equal(old.kind, "waybill_unprocessed");
  assert.doesNotMatch(old.note, /Đang chờ|Mã sai/);
  assert.equal(describeOrphanScan({ isStaff: true, ignoredReason: null, source: "camera_qr", alreadyOrdered: false, ageMs: 1 }).kind, "qr_invalid");
});

test("nhật ký tra đơn theo mã cho lượt mồ côi; hai trang có nhãn cho loại mới", () => {
  const src = readSource("src/lib/warehouse/live/activity.ts");
  assert.ok(src.includes('.in("waybill_code", orphanCodes)'));
  for (const page of ["src/app/dashboard/operations/page.tsx", "src/app/dashboard/(return-module)/returns/page.tsx"]) {
    assert.ok(readSource(page).includes('waybill_unprocessed: "Không tạo đơn"'), page);
  }
});

// ── Lượt quét tới muộn: đặt theo giờ quét ──────────────────────────────

test("migration sắp lượt quét theo thời gian: tìm đơn trước / sau KHÔNG giới hạn thời gian (đơn mở từ hôm trước)", () => {
  const sql = readSource("supabase/migrations/20260926140000_late_scan_chronological.sql");
  assert.ok(!/interval '12 hours'/.test(sql), "giới hạn 12 giờ làm mở đơn thứ hai → vi phạm uniq_open_packing_per_station");
  assert.ok(sql.includes("and pe.scanned_at > v_raw.scanned_at\n    order by pe.scanned_at asc"));
  assert.ok(sql.includes("and pe.scanned_at <= v_raw.scanned_at\n      and pe.raw_event_id <> p_raw_event_id\n    order by pe.scanned_at desc"));
  assert.ok(sql.includes("'late_scan_inserted'"));
  assert.ok(sql.includes("'shortened_by_late_scan'"));
  assert.ok(sql.includes("work_ended_at, work_duration_seconds, timing_note"));
  // Phần không liên quan chép nguyên văn — nhánh mã sai vẫn khởi tạo v_resolved.
  assert.ok(sql.includes("select null::uuid as st_id, null::uuid as wh_id into v_resolved;"));
});

// ── Segment "chưa đóng" ────────────────────────────────────────────────

const clipEnd = new Date("2026-09-26T02:47:41Z");
const openRow = (startedAt: string) => ({ started_at: startedAt, ended_at: null });

test("đoạn cuối mở, hỏi NGAY sau khi đơn xong → vẫn chặn (có thể đang ghi thật)", () => {
  const v = evaluateOpenSegments([openRow("2026-09-26T02:47:00Z")], clipEnd, undefined, new Date("2026-09-26T02:47:50Z"));
  assert.equal(v.blocking, true);
  assert.equal(v.lateReported.length, 0);
});

test(`đoạn cuối mở nhưng đã bắt đầu quá ${OPEN_SEGMENT_CLOSE_GRACE_SECONDS}s → file chắc chắn đã đóng, không chặn`, () => {
  const v = evaluateOpenSegments([openRow("2026-09-26T02:47:00Z")], clipEnd, undefined, new Date("2026-09-26T02:50:01Z"));
  assert.equal(v.blocking, false);
  assert.equal(v.lateReported.length, 1);
  // Đúng tình trạng ảnh chụp: hỏi lại vài giờ sau vẫn KHÔNG được chặn.
  assert.equal(evaluateOpenSegments([openRow("2026-09-26T02:47:00Z")], clipEnd, undefined, new Date("2026-09-26T07:00:00Z")).blocking, false);
});

test("ước giờ đóng: đoạn kế tiếp → độ dài → 60s mặc định; row mở không đủ tuổi thì loại", () => {
  const f = (id: string, started: string, ended: string | null, duration: number | null = null): SegmentFile => ({
    id, file_path: `${id}.mp4`, started_at: started, ended_at: ended, duration_seconds: duration,
  });
  const files = [
    f("a", "2026-09-26T02:45:00Z", "2026-09-26T02:46:00Z"),
    f("b", "2026-09-26T02:46:00Z", null),
    f("c", "2026-09-26T02:46:50Z", null, 45),
    f("d", "2026-09-26T02:47:40Z", null),
  ];
  const out = withEstimatedEnds(files, [{ started_at: "2026-09-26T02:46:00Z" }, { started_at: "2026-09-26T02:46:50Z" }]);
  assert.deepEqual(
    out.map((x) => [x.id, x.ended_at]),
    [
      ["a", "2026-09-26T02:46:00Z"],
      ["b", "2026-09-26T02:46:50.000Z"],
      ["c", "2026-09-26T02:47:35.000Z"],
    ],
    "b đóng ở đầu c; c theo độ dài 45s; d chưa đủ tuổi → loại",
  );
});

test("lỗi 'Segment cuối chưa đóng' cũ là tạm thời — mở xem thì tự cắt lại; lỗi khác vẫn là kết thúc", () => {
  assert.equal(isTransientSegmentFailure("Segment cuối chưa đóng, thử lại sau vài giây."), true);
  assert.equal(isTransientSegmentFailure("Video đã quá hạn lưu trữ."), false);
  assert.equal(isTransientSegmentFailure(null), false);
  const src = readSource("src/app/api/order-proof/[pe_id]/watch/route.ts");
  assert.ok(src.includes("if (latestFailedRow && !isTransientSegmentFailure(latestFailedRow.error_message)) {"));
  const waiting = src.indexOf('if (!cutResult.ok && cutResult.reason === "segment_still_open") {');
  const insertFailed = src.indexOf('status: "failed",\n        error_message: userMessage,');
  assert.ok(waiting > 0 && insertFailed > waiting, "đoạn còn đang ghi: trả 'đang chuẩn bị' TRƯỚC nhánh ghi dòng lỗi");
});

// ── Dung lượng clip: đúng đường cắt thật ───────────────────────────────

test("bitrate nén lại phía cloud KHỚP agent (bitrate.ts)", () => {
  const agent = readSource("warehouse-agent/src/compose/bitrate.ts");
  assert.ok(agent.includes(`export const BASE_VIDEO_KBPS = ${BASE_VIDEO_KBPS};`));
  assert.ok(agent.includes(`export const MIN_VIDEO_KBPS = ${MIN_VIDEO_KBPS};`));
  assert.ok(agent.includes(`export const SIZE_HEADROOM = ${SIZE_HEADROOM};`));
  assert.equal(reencodeKbpsFor(180, GUARD), 3200);
  assert.ok(reencodeKbpsFor(310, GUARD) < 3200);
});

const window180 = computeFinalizedClipWindow({
  scannedAt: new Date("2026-09-26T02:11:48Z"),
  workEndedAt: "2026-09-26T02:14:48Z",
  timingStatus: "capped_timeout",
  workDurationSeconds: 180,
  preSeconds: 5,
  defaultPostSeconds: 60,
});

test("bàn HAI GÓC 180s: ~71 MiB theo bitrate nén — KHÔNG còn báo 'vượt giới hạn ~130 MiB'", () => {
  const e = estimateCompositeProofSize({ window: window180, guardBytes: GUARD, warnBytes: WARN });
  assert.equal(e.estimate_method, "composite_reencode");
  assert.ok(e.estimated_file_size_bytes! < WARN, `${e.estimated_file_size_bytes! / MiB} MiB`);
  assert.equal(e.proof_size_risk, "safe");
  // Cùng cửa sổ, tính kiểu cũ theo dung lượng thô camera 5,8 Mbps → vượt ngưỡng.
  const legacy = estimateProofSize({
    window: window180,
    segments: [],
    fallbackBytesPerSecond: 721_000,
    guardBytes: GUARD,
    warnBytes: WARN,
    correctionFactor: 1.05,
  });
  assert.equal(legacy.proof_size_risk, "over_limit");
});

test("bàn một góc vượt ngưỡng nhưng agent nén lại được → con số SAU khi nén, không còn 'vượt'", () => {
  const legacy = estimateProofSize({ window: window180, segments: [], fallbackBytesPerSecond: 721_000, guardBytes: GUARD, warnBytes: WARN, correctionFactor: 1.05 });
  const refit = applyRefitToFit(legacy, WARN);
  assert.equal(refit.estimate_method, "refit_to_fit");
  assert.notEqual(refit.proof_size_risk, "over_limit");
  assert.equal(refit.estimated_file_size_bytes, reencodedBytes(refit.proof_window_seconds, GUARD));
  // Không vượt thì không đụng.
  const small = estimateProofSize({ window: window180, segments: [], fallbackBytesPerSecond: 100_000, guardBytes: GUARD, warnBytes: WARN, correctionFactor: 1.05 });
  assert.equal(applyRefitToFit(small, WARN), small);
});

test("bộ dựng cảnh báo: hai góc không đọc camera; một góc chỉ nén-lại khi agent có khả năng", () => {
  const src = readSource("src/lib/order-proof/proof-size-risk.ts");
  assert.ok(src.includes("proof_qr_camera_id"));
  assert.ok(src.includes("if (isComposite(event)) return false;"), "hai góc không cần truy vấn segment");
  assert.ok(src.includes("refitCameras.has(cameraId)"));
  assert.ok(src.includes("CAPABILITY.adaptiveClipBitrate"));
});

// ── Camera đã tháo: không còn là sự cố ─────────────────────────────────

const scope: MonitoringScope = {
  orgIds: ["org-a"],
  orgNameById: new Map([["org-a", "Đại Kim"]]),
  warehouseNamesByOrg: new Map(),
  lastScanByOrg: new Map(),
};
const NOW = new Date("2026-09-26T09:00:00Z");
const cam = (id: string, code: string, ok: boolean) => ({
  id,
  camera_code: code,
  organization_id: "org-a",
  last_probe_ok: ok,
  last_probe_at: new Date(NOW.getTime() - 20_000).toISOString(),
  probe_consecutive_fails: ok ? 0 : 10_000,
});

function probeDb(opts: { assigned: string[] | "error"; cameras: unknown[] }) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "abortSignal"]) q[m] = () => q;
      q.then = (res: (v: unknown) => void) => {
        if (table === "station_devices") {
          return res(
            opts.assigned === "error"
              ? { data: null, error: { message: "boom" } }
              : { data: opts.assigned.map((id) => ({ config_json: { camera_id: id } })), error: null },
          );
        }
        return res({ data: opts.cameras, error: null });
      };
      return q;
    },
  } as never;
}

test("camera chưa gắn bàn mà mất kết nối → RA KHỎI danh sách theo dõi (sổ đóng với 'không còn theo dõi'), vẫn được nhắc tên", async () => {
  const c = await checkCameraProbe(
    probeDb({ assigned: ["c-ctc", "c-cqr"], cameras: [cam("c-ctc", "CTC01", true), cam("c-cqr", "CQR01", true), cam("c-dahua", "dahua_01", false)] }),
    NOW,
    scope,
  );
  assert.equal(c.status, "ok");
  assert.ok(!(c.entities ?? []).some((e) => e.code === "dahua_01"), "không còn thực thể → sổ sự cố đóng out_of_scope");
  assert.match(c.message, /dahua_01: mất kết nối nhưng chưa gắn bàn nào/);
  assert.match(c.value, /2\/2 camera bình thường/);
});

test("camera ĐANG gắn bàn mà mất kết nối lâu → vẫn cảnh báo như cũ", async () => {
  const c = await checkCameraProbe(
    probeDb({ assigned: ["c-cqr"], cameras: [cam("c-cqr", "CQR01", false)] }),
    NOW,
    scope,
  );
  assert.equal(c.status, "warn");
});

test("không đọc được bảng phân công → giữ hành vi cũ (thà báo thừa)", async () => {
  const c = await checkCameraProbe(
    probeDb({ assigned: "error", cameras: [cam("c-dahua", "dahua_01", false)] }),
    NOW,
    scope,
  );
  assert.equal(c.status, "warn");
});

test("trang Thiết bị: camera mất kết nối ghi 'Không kết nối được', không còn 'cập nhật 29s trước'", () => {
  const page = readSource("src/app/dashboard/devices/page.tsx");
  assert.ok(page.includes('d.kind === "camera" && d.camera_online_state === "offline"'));
  assert.ok(page.includes("Không kết nối được"));
  assert.ok(page.includes("chưa gắn bàn — lưu trữ nếu đã tháo"));
});
