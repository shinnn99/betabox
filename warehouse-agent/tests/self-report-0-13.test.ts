import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_VIDEO_KBPS,
  MIN_VIDEO_KBPS,
  budgetKbps,
  ffmpegRateArgs,
  videoRateFor,
} from "../src/compose/bitrate";
import { RepeatCollapser, RollingCounter, noiseKey } from "../src/log-noise";
import { TUNING_DEFAULTS, applyCloudTuning } from "../src/runtime-tuning";
import { CAPABILITIES, buildSelfReport, configFingerprint } from "../src/self-report";
import { AGENT_VERSION } from "../src/version";

/**
 * Bản 0.13.0 — kế hoạch VAN-HANH-NHIEU-KHO đợt 7 (+ phần agent của đợt 8):
 * bản tự khai, bitrate thích ứng cho clip dài, gom nhiễu log, núm chỉnh
 * nhận từ cloud.
 */

const LIMIT = 90 * 1024 * 1024;

// ── Phiên bản: bốn chỗ phải khớp ──────────────────────────────────────

test("phiên bản khớp ở version.ts, package.json, file cài đặt, và cloud", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  assert.equal(pkg.version, AGENT_VERSION);
  assert.ok(
    readFileSync("installer/betacom-agent.iss", "utf8").includes(`#define AppVersion     "${AGENT_VERSION}"`),
    "installer/betacom-agent.iss chưa đổi AppVersion",
  );
  assert.ok(
    readFileSync("../src/lib/warehouse/self-report.ts", "utf8").includes(`LATEST_AGENT_VERSION = "${AGENT_VERSION}"`),
    "cloud LATEST_AGENT_VERSION chưa đổi — trang Đội agent sẽ báo nhầm bản cũ",
  );
  assert.ok(readFileSync("RELEASES.md", "utf8").includes(`## ${AGENT_VERSION}`), "RELEASES.md thiếu mục bản này");
});

// ── Bitrate thích ứng ──────────────────────────────────────────────────

test("clip ≤ 200s: GIỮ NGUYÊN 3200k — chất lượng đơn đi không đổi", () => {
  for (const s of [15, 60, 180, 200]) {
    const r = videoRateFor(s, LIMIT);
    assert.equal(r.bitrateKbps, BASE_VIDEO_KBPS, `${s}s`);
    assert.equal(r.adapted, false);
  }
  assert.deepEqual(ffmpegRateArgs(videoRateFor(180, LIMIT)), ["-b:v", "3200k", "-maxrate", "4500k", "-bufsize", "9000k"]);
});

test("không truyền ngưỡng: y hệt trước 0.13.0", () => {
  assert.deepEqual(ffmpegRateArgs(videoRateFor(310)), ["-b:v", "3200k", "-maxrate", "4500k", "-bufsize", "9000k"]);
});

test("kiện hoàn 310s: hạ bitrate, dung lượng ước tính (kể cả đỉnh) vừa 90 MiB", () => {
  const r = videoRateFor(310, LIMIT);
  assert.equal(r.adapted, true);
  assert.ok(r.bitrateKbps < BASE_VIDEO_KBPS);
  const avgBytes = (r.bitrateKbps * 1000 * 310) / 8;
  assert.ok(avgBytes <= LIMIT * 0.86, `trung bình ${avgBytes} phải chừa ≥ 14%`);
  assert.ok(r.maxrateKbps <= Math.floor(r.bitrateKbps * 1.25));
  // Trước 0.13.0: 3200k × 310s = 124 MB > 90 MiB → bị từ chối.
  assert.ok((BASE_VIDEO_KBPS * 1000 * 310) / 8 > LIMIT);
});

test("clip rất dài: không hạ dưới sàn — thà để guard từ chối còn hơn clip mờ vô dụng", () => {
  assert.equal(videoRateFor(3 * 3600, LIMIT).bitrateKbps, MIN_VIDEO_KBPS);
  assert.ok(budgetKbps(3 * 3600, LIMIT) < MIN_VIDEO_KBPS);
});

test("bộ ghép dùng bitrate thích ứng; đường cắt có bước nén lại trước khi từ chối", () => {
  const composer = readFileSync("src/compose/clip-composer.ts", "utf8");
  assert.ok(composer.includes("...ffmpegRateArgs(videoRateFor(durationSeconds, options.maxOutputBytes)),"));
  assert.ok(!composer.includes('"-b:v", "3200k"'), "bitrate cứng phải bỏ");
  const index = readFileSync("src/index.ts", "utf8");
  assert.ok(index.includes("maxOutputBytes: config.maxProofClipUploadBytes,"));
  const refit = index.indexOf("reencodeToFit({");
  const reject = index.indexOf("await failCommand(sizeRejection.message, sizeRejection.metadata);");
  assert.ok(refit > 0 && reject > refit, "phải thử nén lại TRƯỚC khi từ chối");
});

// ── Gom nhiễu ──────────────────────────────────────────────────────────

test("khoá so trùng bỏ số, hex, id — câu cùng dạng là một", () => {
  assert.equal(
    noiseKey("[h264 @ 0x55d2c1] error while decoding MB 45 12, bytestream -5"),
    noiseKey("[h264 @ 0x7f00aa] error while decoding MB 3 99, bytestream -17"),
  );
  assert.notEqual(noiseKey("MediaMTX exited code=1"), noiseKey("[heartbeat] watchdog liveness stale"));
});

test("câu lặp: lần đầu gửi, phần lặp gom thành MỘT dòng khi hết khoảng", () => {
  let t = 0;
  const c = new RepeatCollapser(() => 60_000, () => t);
  assert.equal(c.admit("warn", "[camera-heal] cam 1 retry 3"), true);
  t = 1_000;
  assert.equal(c.admit("warn", "[camera-heal] cam 1 retry 4"), false);
  assert.equal(c.admit("warn", "[camera-heal] cam 1 retry 5"), false);
  assert.equal(c.admit("error", "FATAL unhandledRejection x"), true, "câu KHÁC vẫn đi ngay");
  assert.deepEqual(c.drainExpired(), [], "chưa hết khoảng");
  t = 61_000;
  const out = c.drainExpired();
  assert.equal(out.length, 1);
  assert.match(out[0].message, /^\(lặp lại 2 lần trong 1 phút\) \[camera-heal\] cam 1 retry 5$/);
  assert.equal(c.admit("warn", "[camera-heal] cam 1 retry 9"), true, "khoảng mới: lại đi ngay");
});

test("câu không lặp thì không có dòng tóm tắt", () => {
  let t = 0;
  const c = new RepeatCollapser(() => 1_000, () => t);
  c.admit("warn", "một lần");
  t = 5_000;
  assert.deepEqual(c.drainExpired(), []);
});

test("đếm 60 phút trượt", () => {
  let t = 0;
  const r = new RollingCounter(() => t);
  r.record(5);
  t = 30 * 60_000;
  r.record(2);
  assert.equal(r.lastHour(), 7);
  t = 61 * 60_000;
  assert.equal(r.lastHour(), 2, "ô 60 phút trước đã rơi ra");
});

test("nhiễu [qr-frame-source] thành tỉ lệ, không còn một dòng mỗi mẩu stderr", () => {
  const src = readFileSync("src/qr/qr-frame-source.ts", "utf8");
  assert.ok(src.includes("if (clean) this.onNoise(clean);"));
  assert.ok(!src.includes("if (clean) console.warn(`[qr-frame-source] ${clean.slice(-1_000)}`);"));
  assert.ok(src.includes("this.badFrames.record();"));
});

// ── Núm chỉnh từ cloud ─────────────────────────────────────────────────

test("núm chỉnh từ cloud: nhận trong khoảng 10–3600s, bỏ qua giá trị lạ", () => {
  const t = { ...TUNING_DEFAULTS };
  assert.deepEqual(applyCloudTuning({ log_repeat_window_seconds: 120, qr_noise_window_seconds: 900 }, t), [
    "logRepeatWindowMs",
    "qrNoiseWindowMs",
  ]);
  assert.equal(t.logRepeatWindowMs, 120_000);
  assert.deepEqual(applyCloudTuning({ log_repeat_window_seconds: 120 }, t), [], "không đổi thì không báo");
  assert.deepEqual(applyCloudTuning({ log_repeat_window_seconds: 1, qr_noise_window_seconds: "x" }, t), []);
  assert.deepEqual(applyCloudTuning(null, t), []);
  assert.equal(t.logRepeatWindowMs, 120_000);
});

// ── Bản tự khai ────────────────────────────────────────────────────────

test("bản tự khai: đúng định dạng cloud đọc, không bịa số hàng đợi clip", () => {
  const r = buildSelfReport({
    uptimeSeconds: 3600.4,
    cameras: [
      { cameraId: "cam-1", recording: true, lastSegmentAt: new Date("2026-09-26T08:00:00Z"), badFramesLastHour: 120 },
      { cameraId: "cam-2", recording: false, lastSegmentAt: null, badFramesLastHour: null },
    ],
    disk: { freeBytes: 100, totalBytes: 1000, bytesPerRecordingHour: 10 },
    scansPending: 3,
    lastQrSuccessAt: null,
    configFingerprint: "abc",
  });
  assert.equal(r.version, AGENT_VERSION);
  assert.equal(r.uptime_s, 3600);
  assert.deepEqual(r.cameras, [
    { code: "cam-1", recording: true, last_segment_at: "2026-09-26T08:00:00.000Z", bad_frames_last_hour: 120 },
    { code: "cam-2", recording: false, last_segment_at: null, bad_frames_last_hour: null },
  ]);
  assert.deepEqual(r.disk, { free_bytes: 100, total_bytes: 1000, bytes_per_day: 240 });
  assert.deepEqual(r.queues, { scans_pending: 3, clips_pending: null, uploads_pending: null });
  assert.deepEqual(r.capabilities, [...CAPABILITIES]);
  assert.ok((r.capabilities as string[]).includes("adaptive_clip_bitrate"));
});

test("dấu vân tay cấu hình: không phụ thuộc bí mật, đổi khi cấu hình đổi", () => {
  const a = configFingerprint({ backendUrl: "https://x", agentSecret: "s1", heartbeatIntervalMs: 30000 });
  const b = configFingerprint({ backendUrl: "https://x", agentSecret: "s2", heartbeatIntervalMs: 30000 });
  const c = configFingerprint({ backendUrl: "https://x", agentSecret: "s1", heartbeatIntervalMs: 60000 });
  assert.equal(a, b, "đổi bí mật không được đổi dấu vân tay — tức là bí mật không nằm trong đó");
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("nhịp tim: bản tự khai hỏng không làm mất nhịp tim; gói chẩn đoán che tài khoản RTSP", () => {
  const index = readFileSync("src/index.ts", "utf8");
  assert.ok(index.includes("selfReport: await collectSelfReport(),"));
  assert.ok(index.includes("[self-report] không dựng được bản tự khai"));
  assert.ok(index.includes("last_stderr: maskRtspUrl("));
  assert.ok(index.includes("const recentProblems = remoteLogger.recent().map(maskRtspUrl);"));
  assert.ok(index.includes("recent_problems: recentProblems,"));
  const hb = readFileSync("src/heartbeat.ts", "utf8");
  assert.ok(hb.includes("if (params.selfReport) bodyObj.self_report = params.selfReport;"));
});
