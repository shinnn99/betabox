import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Job đóng row `camera_recording_files` mồ côi.
 *
 * Sự cố có thật (04/09/2026, kho Đại Kim): 1 row `ended_at IS NULL` từ
 * 27/08 — agent chết giữa segment, không kịp ghi ended_at — chặn cắt clip
 * cho 92 đơn liên tiếp trong 8 ngày.
 *
 * Bộ test khoá các tính chất:
 *   1. Row đủ cũ được đóng, ended_at lấy từ segment kế tiếp (mốc thật).
 *   2. Row CHƯA đủ cũ KHÔNG bị đụng — đây là vế chống fix quá tay: đóng
 *      nhầm segment đang ghi thì clip mất đuôi.
 *   3. UPDATE mang điều kiện ended_at IS NULL để không ghi đè số của
 *      agent nếu agent kịp đóng row giữa lúc job chạy.
 *   4. Mọi lần chạy ghi đúng 1 dòng system_jobs; ghi sổ hỏng không kéo
 *      job chết theo.
 */

interface JobRow {
  job_name: string;
  ok: boolean;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
}

interface UpdateCall {
  patch: Record<string, unknown>;
  eqId: string | null;
  guardedByEndedAtNull: boolean;
}

const NOW = new Date("2026-09-04T09:00:00.000Z");
/** 27/08 — row mồ côi thật đã cắn. */
const ORPHAN = {
  id: "07d761da-a972-46f6-9b1b-84b11ad1a4a5",
  organization_id: "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8",
  camera_id: "3a5112e0-3197-4d55-badb-efc37418612e",
  started_at: "2026-08-27T07:25:31.000Z",
};

/**
 * Client giả cho bảng camera_recording_files.
 *
 * `orphans` = kết quả của SELECT tìm row mồ côi.
 * `nextStart` = started_at của segment kế tiếp (null = không có).
 */
function fakeSegmentClient(opts: {
  orphans: unknown[];
  nextStart?: string | null;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const updates: UpdateCall[] = [];
  const selectFilters: { lt: string[]; isNull: string[] } = { lt: [], isNull: [] };
  let selectCount = 0;

  function makeQuery() {
    const state = {
      isUpdate: false,
      patch: {} as Record<string, unknown>,
      eqId: null as string | null,
      endedAtNullGuard: false,
      isNextLookup: false,
    };

    const q: Record<string, unknown> = {
      select: () => {
        selectCount += 1;
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        state.isUpdate = true;
        state.patch = patch;
        return q;
      },
      is: (col: string, val: unknown) => {
        if (col === "ended_at" && val === null) {
          if (state.isUpdate) state.endedAtNullGuard = true;
          else selectFilters.isNull.push(col);
        }
        return q;
      },
      eq: (col: string, val: unknown) => {
        if (col === "id") state.eqId = val as string;
        return q;
      },
      gt: () => {
        // Chỉ nhánh tìm segment kế tiếp dùng .gt("started_at", ...)
        state.isNextLookup = true;
        return q;
      },
      lt: (_col: string, val: unknown) => {
        selectFilters.lt.push(val as string);
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: () => ({
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data:
              opts.nextStart === undefined || opts.nextStart === null
                ? null
                : { started_at: opts.nextStart },
            error: null,
          }),
      }),
      then: (resolve: (v: unknown) => void) => {
        if (state.isUpdate) {
          updates.push({
            patch: state.patch,
            eqId: state.eqId,
            guardedByEndedAtNull: state.endedAtNullGuard,
          });
          return resolve({ error: opts.updateError ?? null });
        }
        return resolve({
          data: opts.selectError ? null : opts.orphans,
          error: opts.selectError ?? null,
        });
      },
    };
    return q;
  }

  return {
    updates,
    selectFilters,
    get selectCount() {
      return selectCount;
    },
    client: { from: () => makeQuery() },
  };
}

/** Client giả cho việc GHI SỔ — cùng nếp với tests/system-jobs-cleanup.test.ts. */
function fakeJobClient(behaviour: "ok" | "db_error" | "throw" = "ok") {
  const rows: JobRow[] = [];
  const tables: string[] = [];
  return {
    rows,
    tables,
    client: {
      from: (table: string) => {
        tables.push(table);
        return {
          insert: (row: JobRow) => {
            if (behaviour === "throw") throw new Error("kết nối rớt");
            rows.push(row);
            return {
              then: (resolve: (v: unknown) => void) =>
                resolve(
                  behaviour === "db_error"
                    ? { error: { message: 'relation "system_jobs" does not exist' } }
                    : { error: null },
                ),
            };
          },
        };
      },
    },
  };
}

// ── Đóng row mồ côi ─────────────────────────────────────────────────────

test("row mồ côi có segment kế tiếp → đóng với ended_at = mốc segment kế", async () => {
  const seg = fakeSegmentClient({
    orphans: [ORPHAN],
    nextStart: "2026-08-27T07:26:31.000Z",
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.closed, 1);
  assert.equal(seg.updates.length, 1);
  assert.equal(seg.updates[0].eqId, ORPHAN.id);
  assert.equal(seg.updates[0].patch.ended_at, "2026-08-27T07:26:31.000Z");
  assert.equal(seg.updates[0].patch.duration_seconds, 60);
});

test("row mồ côi KHÔNG có segment kế → đóng độ dài 0, không bịa số từ now", async () => {
  const seg = fakeSegmentClient({ orphans: [ORPHAN], nextStart: null });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok && result.closed, 1);
  assert.equal(
    seg.updates[0].patch.ended_at,
    ORPHAN.started_at,
    "ended_at = started_at, không phải now (row có thể cũ hàng tuần)",
  );
  assert.equal(seg.updates[0].patch.duration_seconds, 0);
});

test("segment kế cách 8 NGÀY → KHÔNG nhận vơ, chốt độ dài 0", async () => {
  // Ca thật ở kho Đại Kim: row mồ côi 27/08 07:25, segment kế 04/09
  // 08:39 — camera ngừng ghi cả tuần. Nếu ghi ended_at = mốc segment kế
  // thì row này tự nhận là segment dài 8 ngày và PHỦ mọi cửa sổ clip
  // trong khoảng ấy như thể có video → resolver ghép file không tồn tại.
  const seg = fakeSegmentClient({
    orphans: [ORPHAN],
    nextStart: "2026-09-04T08:39:09.000Z",
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok && result.closed, 1);
  assert.equal(
    seg.updates[0].patch.ended_at,
    ORPHAN.started_at,
    "không được lấy mốc cách 8 ngày làm ended_at",
  );
  assert.equal(seg.updates[0].patch.duration_seconds, 0);
});

test("segment kế cách 5 phút (biên trần) → vẫn nhận là liền kề", async () => {
  const nextMs = Date.parse(ORPHAN.started_at) + 300 * 1000;
  const seg = fakeSegmentClient({
    orphans: [ORPHAN],
    nextStart: new Date(nextMs).toISOString(),
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok && result.closed, 1);
  assert.equal(seg.updates[0].patch.duration_seconds, 300);
});

test("segment kế cách 5 phút 1 giây → quá trần, chốt độ dài 0", async () => {
  const nextMs = Date.parse(ORPHAN.started_at) + 301 * 1000;
  const seg = fakeSegmentClient({
    orphans: [ORPHAN],
    nextStart: new Date(nextMs).toISOString(),
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(seg.updates[0].patch.ended_at, ORPHAN.started_at);
  assert.equal(seg.updates[0].patch.duration_seconds, 0);
});

test("UPDATE luôn kèm điều kiện ended_at IS NULL (không ghi đè số của agent)", async () => {
  const seg = fakeSegmentClient({ orphans: [ORPHAN], nextStart: "2026-08-27T07:26:31.000Z" });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(
    seg.updates[0].guardedByEndedAtNull,
    true,
    "agent kịp đóng row giữa lúc job chạy thì số của agent phải thắng",
  );
});

// ── Vế chống quá tay: không đụng row còn trẻ ───────────────────────────

test("cutoff lùi ít nhất 20 phút so với now — segment đang ghi không lọt vào SELECT", async () => {
  const seg = fakeSegmentClient({ orphans: [] });
  const { closeOrphanSegments, ORPHAN_SEGMENT_MIN_AGE_SECONDS } = await import(
    "../src/lib/system/orphan-segments.ts"
  );
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.closed, 0);
  assert.equal(seg.updates.length, 0, "không có row nào thì không được UPDATE gì");

  // Ngưỡng phải bảo thủ HƠN ngưỡng resolver dùng để phân loại mồ côi.
  const { OPEN_SEGMENT_MAX_AGE_SECONDS } = await import(
    "../src/lib/order-proof/open-segment-verdict.ts"
  );
  assert.ok(
    ORPHAN_SEGMENT_MIN_AGE_SECONDS > OPEN_SEGMENT_MAX_AGE_SECONDS,
    "job GHI vào DB nên phải bảo thủ hơn hàm chỉ đọc",
  );

  const cutoffMs = Date.parse(result.ok ? result.cutoff_iso : "");
  assert.equal(
    cutoffMs,
    NOW.getTime() - ORPHAN_SEGMENT_MIN_AGE_SECONDS * 1000,
    "cutoff tính từ now truyền vào, không từ đồng hồ thật",
  );
  assert.deepEqual(seg.selectFilters.lt, [result.ok ? result.cutoff_iso : ""]);
  assert.deepEqual(
    seg.selectFilters.isNull,
    ["ended_at"],
    "SELECT phải lọc đúng row còn mở",
  );
});

// ── Lỗi ─────────────────────────────────────────────────────────────────

test("SELECT lỗi → trả ok=false, không UPDATE gì", async () => {
  const seg = fakeSegmentClient({
    orphans: [],
    selectError: { message: "connection reset by peer" },
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "select_failed");
  assert.equal(seg.updates.length, 0);
});

test("UPDATE lỗi trên 1 row → không tính là đã đóng, job vẫn ok", async () => {
  const seg = fakeSegmentClient({
    orphans: [ORPHAN],
    nextStart: "2026-08-27T07:26:31.000Z",
    updateError: { message: "deadlock detected" },
  });
  const { closeOrphanSegments } = await import("../src/lib/system/orphan-segments.ts");
  const result = await closeOrphanSegments({ client: seg.client as never, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.closed, 0, "đếm phải phản ánh thực tế, không thổi phồng");
  assert.equal(result.ok && result.found, 1);
});

// ── Ghi sổ ──────────────────────────────────────────────────────────────

test("ca ok: ghi đúng 1 dòng system_jobs với job_name cố định", async () => {
  const seg = fakeSegmentClient({ orphans: [ORPHAN], nextStart: "2026-08-27T07:26:31.000Z" });
  const job = fakeJobClient("ok");
  const { runCloseOrphanSegmentsJob } = await import("../src/lib/system/orphan-segments.ts");
  const result = await runCloseOrphanSegmentsJob({
    client: seg.client as never,
    now: NOW,
    jobClient: job.client as never,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(job.tables, ["system_jobs"]);
  assert.equal(job.rows.length, 1);
  assert.equal(job.rows[0].job_name, "close-orphan-segments");
  assert.equal(job.rows[0].ok, true);
  assert.equal((job.rows[0].detail as { closed: number }).closed, 1);
});

test("nửa âm: detail không mang camera_id / org_id vào bảng platform-global", async () => {
  const seg = fakeSegmentClient({ orphans: [ORPHAN], nextStart: "2026-08-27T07:26:31.000Z" });
  const job = fakeJobClient("ok");
  const { runCloseOrphanSegmentsJob } = await import("../src/lib/system/orphan-segments.ts");
  await runCloseOrphanSegmentsJob({
    client: seg.client as never,
    now: NOW,
    jobClient: job.client as never,
  });

  const serialized = JSON.stringify(job.rows[0].detail);
  assert.doesNotMatch(serialized, /3a5112e0/, "camera_id không được lọt vào system_jobs");
  assert.doesNotMatch(serialized, /e3cb7cd1/, "organization_id không được lọt vào");
});

test("ca ghi sổ hỏng: việc dọn vẫn trả kết quả nguyên vẹn", async () => {
  const seg = fakeSegmentClient({ orphans: [ORPHAN], nextStart: "2026-08-27T07:26:31.000Z" });
  const job = fakeJobClient("throw");
  const { runCloseOrphanSegmentsJob } = await import("../src/lib/system/orphan-segments.ts");
  const result = await runCloseOrphanSegmentsJob({
    client: seg.client as never,
    now: NOW,
    jobClient: job.client as never,
  });

  assert.equal(result.ok, true, "recordSystemJob không bao giờ throw");
  assert.equal(result.ok && result.closed, 1);
});

test("ca ngoại lệ: việc dọn ném → ghi ok=false rồi ném tiếp", async () => {
  const job = fakeJobClient("ok");
  const exploding = {
    from: () => {
      throw new Error("service key sai");
    },
  };
  const { runCloseOrphanSegmentsJob } = await import("../src/lib/system/orphan-segments.ts");

  await assert.rejects(
    () =>
      runCloseOrphanSegmentsJob({
        client: exploding as never,
        now: NOW,
        jobClient: job.client as never,
      }),
    /service key sai/,
  );
  assert.equal(job.rows.length, 1, "vẫn phải ghi sổ trước khi ném");
  assert.equal(job.rows[0].ok, false);
  assert.equal((job.rows[0].detail as { error: string }).error, "exception");
});
