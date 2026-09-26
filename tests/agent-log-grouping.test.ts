import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOG_BUCKET_MINUTES,
  groupLogEvents,
  logBucketStart,
  logDedupeKey,
  logOccurrences,
  parseRepeatSummary,
  type LogEventInput,
} from "@/lib/warehouse/log-grouping";
import { isMissingFunctionError } from "@/lib/supabase/missing-column";

/**
 * Đợt 8 — kế hoạch VAN-HANH-NHIEU-KHO: gom log agent ở cloud. Đo 7 ngày ở
 * một kho: 26.990 dòng, 77% nhiễu; nghiệm thu: một kho dưới 2.000 dòng / tuần.
 */

const at = (iso: string) => Date.parse(iso);
const ev = (level: "warn" | "error", message: string, iso: string): LogEventInput => ({
  level,
  message,
  emittedAtMs: at(iso),
});

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `không thấy đoạn ${start} … ${end}`);
  return src.slice(i, j + end.length).replace(/\s+/g, "");
};

test("khoá gom cloud là bản sao đúng từng phép thay của noiseKey bên agent", () => {
  const agent = readFileSync("warehouse-agent/src/log-noise.ts", "utf8");
  const cloud = readFileSync("src/lib/warehouse/log-grouping.ts", "utf8");
  assert.equal(
    between(cloud, "return message", ".slice(0, 160);"),
    between(agent, "return message", ".slice(0, 160);"),
  );
});

test("dòng tóm tắt của agent 0.13.0 đúng khuôn cloud đọc được", () => {
  const agent = readFileSync("warehouse-agent/src/log-noise.ts", "utf8");
  assert.ok(
    agent.includes("`(lặp lại ${e.suppressed} lần trong ${minutes} phút) ${e.sample}`"),
    "agent đổi khuôn dòng tóm tắt — sửa REPEAT_SUMMARY ở cloud theo",
  );
  const suppressed = 40;
  const minutes = 10;
  const sample = "[qr-frame-source] frame timeout 999ms";
  assert.deepEqual(parseRepeatSummary(`(lặp lại ${suppressed} lần trong ${minutes} phút) ${sample}`), {
    count: 40,
    message: sample,
  });
});

test("câu thường và tiền tố hỏng giữ nguyên, đếm 1", () => {
  assert.deepEqual(parseRepeatSummary("FATAL mediamtx exited"), { count: 1, message: "FATAL mediamtx exited" });
  assert.deepEqual(parseRepeatSummary("(lặp lại 0 lần trong 1 phút) x"), {
    count: 1,
    message: "(lặp lại 0 lần trong 1 phút) x",
  });
  // Không có câu mẫu sau tiền tố → không phải dòng tóm tắt.
  assert.equal(parseRepeatSummary("(lặp lại 5 lần trong 1 phút) ").count, 1);
});

test("khoá bỏ số, hex, id — hai câu chỉ khác số là một", () => {
  assert.equal(
    logDedupeKey("[qr-frame-source] frame timeout 1234ms"),
    logDedupeKey("[qr-frame-source] frame timeout 7ms"),
  );
  assert.equal(
    logDedupeKey("clip 3f2c1a9e-1b2c-4d5e-8f90-123456789abc failed 0x1f"),
    logDedupeKey("clip 00000000-aaaa-bbbb-cccc-000000000000 failed 0xff"),
  );
  assert.notEqual(logDedupeKey("FATAL mediamtx exited"), logDedupeKey("mediamtx restarted"));
});

test("khung: 60 phút cho warn, 30 phút cho error", () => {
  assert.deepEqual(LOG_BUCKET_MINUTES, { warn: 60, error: 30 });
  assert.equal(logBucketStart("warn", at("2026-09-26T09:59:59Z")), "2026-09-26T09:00:00.000Z");
  assert.equal(logBucketStart("error", at("2026-09-26T09:31:00Z")), "2026-09-26T09:30:00.000Z");
  assert.equal(logBucketStart("error", at("2026-09-26T09:29:59Z")), "2026-09-26T09:00:00.000Z");
});

test("gom một lô: cùng mức + khung + câu → một phần tử, đếm cả dòng tóm tắt", () => {
  const out = groupLogEvents([
    ev("warn", "[qr-frame-source] frame timeout 1234ms", "2026-09-26T09:10:00Z"),
    ev("error", "FATAL mediamtx exited code 1", "2026-09-26T09:11:00Z"),
    ev("warn", "[qr-frame-source] frame timeout 7ms", "2026-09-26T09:05:00Z"),
    ev("warn", "(lặp lại 40 lần trong 10 phút) [qr-frame-source] frame timeout 3ms", "2026-09-26T09:20:00Z"),
    ev("warn", "[qr-frame-source] frame timeout 9ms", "2026-09-26T10:00:01Z"),
    ev("error", "FATAL mediamtx exited code 2", "2026-09-26T09:40:00Z"),
  ]);
  assert.equal(out.length, 4);
  const [qr, fatal, qrNext, fatalNext] = out;
  assert.deepEqual(qr, {
    level: "warn",
    message: "[qr-frame-source] frame timeout 7ms", // câu SỚM NHẤT
    emitted_at: "2026-09-26T09:05:00.000Z",
    last_emitted_at: "2026-09-26T09:20:00.000Z",
    dedupe_key: logDedupeKey("[qr-frame-source] frame timeout 7ms"),
    bucket_start: "2026-09-26T09:00:00.000Z",
    count: 42,
  });
  assert.equal(fatal.count, 1);
  assert.equal(fatal.bucket_start, "2026-09-26T09:00:00.000Z");
  // Sang giờ mới → dòng mới, dù cùng câu.
  assert.equal(qrNext.bucket_start, "2026-09-26T10:00:00.000Z");
  assert.equal(qrNext.count, 1);
  // Error khung 30 phút: 09:40 là khung khác 09:11.
  assert.equal(fatalNext.bucket_start, "2026-09-26T09:30:00.000Z");
});

test("nghiệm thu đợt 8: tuần nhiễu như đo ở một kho còn dưới 2.000 dòng", () => {
  // 7 ngày × 10 giờ làm việc. Nhiễu như số đo: qr-frame-source 20.948 lần,
  // cùng 9 câu warn thường trực khác, 528 FATAL, 525 MediaMTX chết.
  const events: LogEventInput[] = [];
  const hours: number[] = [];
  for (let d = 0; d < 7; d++) for (let h = 1; h <= 10; h++) hours.push(Date.UTC(2026, 8, 20 + d, h));
  const spread = (n: number, level: "warn" | "error", text: (i: number) => string) => {
    for (let i = 0; i < n; i++) {
      const hour = hours[i % hours.length];
      events.push({ level, message: text(i), emittedAtMs: hour + ((i * 7919) % 3_600_000) });
    }
  };
  spread(20_948, "warn", (i) => `[qr-frame-source] frame timeout ${i % 997}ms`);
  for (let k = 0; k < 9; k++) spread(4_000 / 9, "warn", (i) => `[warn-${"abcdefghi"[k]}] retry ${i}`);
  spread(528, "error", (i) => `FATAL uncaught at clip ${i}`);
  spread(525, "error", (i) => `mediamtx exited with code ${i % 3}`);
  assert.ok(events.length > 26_000);

  const rows = groupLogEvents(events);
  assert.ok(rows.length < 2_000, `còn ${rows.length} dòng`);
  // Không mất lần nào: tổng đếm = số sự kiện.
  assert.equal(
    rows.reduce((n, r) => n + r.count, 0),
    events.length,
  );
  // Lỗi thật vẫn nổi: mỗi khung error có dòng riêng.
  assert.ok(rows.some((r) => r.level === "error" && r.message.startsWith("FATAL")));
});

test("dòng trước migration (không cột repeat_count) đếm là một lần", () => {
  assert.equal(logOccurrences({}), 1);
  assert.equal(logOccurrences({ repeat_count: null }), 1);
  assert.equal(logOccurrences({ repeat_count: 0 }), 1);
  assert.equal(logOccurrences({ repeat_count: 50 }), 50);
});

test("nhận ra database chưa có hàm RPC — theo đúng tên hàm", () => {
  const fn = "ingest_agent_log_events";
  assert.equal(
    isMissingFunctionError(
      {
        code: "PGRST202",
        message: `Could not find the function public.${fn}(p_agent_id, p_events, p_organization_id) in the schema cache`,
      },
      fn,
    ),
    true,
  );
  assert.equal(isMissingFunctionError({ code: "42883", message: `function public.${fn}(uuid) does not exist` }, fn), true);
  assert.equal(
    isMissingFunctionError({ code: "PGRST202", message: "Could not find the function public.other_fn() in the schema cache" }, fn),
    false,
  );
  assert.equal(isMissingFunctionError({ code: "23505", message: `duplicate key ${fn}` }, fn), false);
  assert.equal(isMissingFunctionError(null, fn), false);
});

test("route: gom rồi gọi RPC; chỉ lùi về ghi thẳng khi database chưa có hàm", () => {
  const src = readFileSync("src/app/api/agent/log-events/route.ts", "utf8");
  assert.ok(src.includes('admin.rpc("ingest_agent_log_events"'));
  assert.ok(src.includes("p_events: groupLogEvents(events)"));
  assert.ok(src.includes('isMissingFunctionError(rpcErr, "ingest_agent_log_events")'));
  // Lỗi khác (không phải thiếu hàm) → 500, không nuốt thành ghi thẳng.
  const i = src.indexOf('if (!isMissingFunctionError(rpcErr, "ingest_agent_log_events"))');
  const j = src.indexOf('.from("agent_log_events").insert(');
  assert.ok(i > 0 && j > i);
  assert.ok(src.slice(i, j).includes("status: 500"));
});

test("migration: gộp trùng khoá trong lô, chỉ mục gom, hạn lưu 30 ngày bằng pg_cron", () => {
  const sql = readFileSync("supabase/migrations/20260926150000_agent_log_grouping_retention.sql", "utf8");
  assert.ok(sql.includes("GROUP BY level, dedupe_key, bucket_start"));
  assert.ok(sql.includes("ON CONFLICT (agent_id, level, dedupe_key, bucket_start) WHERE dedupe_key IS NOT NULL"));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS agent_log_events_group_uniq/.test(sql));
  // Chạy lại không đẻ hai job.
  const unschedule = sql.indexOf("cron.unschedule");
  const schedule = sql.indexOf("cron.schedule(");
  assert.ok(unschedule > 0 && schedule > unschedule);
  assert.ok(sql.includes("prune_agent_log_events(30)"));
  // Chỉ service_role gọi được.
  assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.ingest_agent_log_events(uuid, uuid, jsonb) TO service_role"));
  assert.ok(sql.includes("REVOKE ALL ON FUNCTION public.ingest_agent_log_events(uuid, uuid, jsonb) FROM anon, authenticated"));
});

test("hai trang platform đọc repeat_count và lùi được khi chưa có cột", () => {
  for (const f of ["src/app/api/platform/orgs/route.ts", "src/app/api/platform/orgs/[id]/route.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("repeat_count"), f);
    assert.ok(src.includes('isMissingColumnError(') && src.includes('"repeat_count")'), f);
    assert.ok(src.includes("logOccurrences("), f);
  }
});
