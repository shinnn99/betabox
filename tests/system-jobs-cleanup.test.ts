import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Sổ chạy job của cron dọn clip (`system_jobs`).
 *
 * Sự cố có thật (08/2026): sau khi chuyển Vercel → VPS, lịch cron vẫn nằm
 * trong vercel.json — VPS không đọc file đó — nên job dọn clip chết âm
 * thầm 5 ngày. Không ai biết vì không có chỗ nào ghi lại lần chạy.
 *
 * Bộ test này khoá 2 tính chất mà cảnh báo giai đoạn 2 dựa vào:
 *   1. MỌI lần chạy đều để lại đúng 1 dòng — ok, lỗi, hay ném ngoại lệ.
 *   2. Việc ghi sổ KHÔNG được làm hỏng việc dọn clip. Nếu ghi sổ hỏng mà
 *      kéo job chết theo thì nó gây ra đúng loại sự cố nó sinh ra để phát
 *      hiện.
 */

interface JobRow {
  job_name: string;
  ok: boolean;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
}

/**
 * Client giả cho việc DỌN clip. Mọi bước chain trả về chính nó và bản thân
 * nó thenable — cùng nếp với tests/cleanup-expired-clips-scope.test.ts.
 *
 * `fetchResult` quyết định nhánh: {data: [], error: null} → dọn 0 clip
 * (ca ok); {data: null, error} → nhánh fetch_failed.
 */
function fakeClipClient(fetchResult: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {
    select: () => q,
    not: () => q,
    lt: () => q,
    in: () => q,
    update: () => q,
    eq: () => q,
    then: (resolve: (v: unknown) => void) => resolve(fetchResult),
  };
  return {
    from: () => q,
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
}

/** Client giả cho việc GHI SỔ. Thu lại row đã insert. */
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

async function runJob(
  fetchResult: { data: unknown; error: unknown },
  jobBehaviour: "ok" | "db_error" | "throw" = "ok",
) {
  const job = fakeJobClient(jobBehaviour);
  const { runCleanupClipsJob } = await import("../src/lib/system/cleanup-clips-job.ts");
  const result = await runCleanupClipsJob({
    clipClient: fakeClipClient(fetchResult) as never,
    jobClient: job.client as never,
  });
  return { result, rows: job.rows, tables: job.tables };
}

const OK_FETCH = { data: [], error: null };
const FAILED_FETCH = { data: null, error: { message: "connection reset by peer" } };

// ── Ca ok ───────────────────────────────────────────────────────────────

test("ca ok: chạy xong ghi 1 dòng system_jobs với ok=true", async () => {
  const { result, rows, tables } = await runJob(OK_FETCH);

  assert.equal(result.ok, true);
  assert.deepEqual(tables, ["system_jobs"]);
  assert.equal(rows.length, 1, "đúng 1 dòng mỗi lần chạy");
  assert.equal(rows[0].job_name, "cleanup-clips", "job_name là chuỗi cảnh báo query");
  assert.equal(rows[0].ok, true);
  assert.equal(typeof rows[0].duration_ms, "number");
  assert.ok(rows[0].duration_ms! >= 0);
  assert.equal((rows[0].detail as { deleted: number }).deleted, 0);
});

// ── Ca job lỗi ──────────────────────────────────────────────────────────

test("ca lỗi: dọn clip fail vẫn ghi sổ, ok=false + mã lỗi", async () => {
  const { result, rows } = await runJob(FAILED_FETCH);

  assert.equal(result.ok, false);
  assert.equal(rows.length, 1, "lỗi cũng phải để lại dấu vết, không im lặng");
  assert.equal(rows[0].ok, false);
  assert.equal((rows[0].detail as { error: string }).error, "fetch_failed");
  assert.match(
    (rows[0].detail as { message: string }).message,
    /connection reset/,
    "giữ nguyên nhân để chẩn đoán",
  );
});

test("ca ngoại lệ: dọn clip ném → ghi ok=false rồi ném tiếp", async () => {
  const job = fakeJobClient("ok");
  const exploding = {
    from: () => {
      throw new Error("service key sai");
    },
  };
  const { runCleanupClipsJob } = await import("../src/lib/system/cleanup-clips-job.ts");

  await assert.rejects(
    () =>
      runCleanupClipsJob({
        clipClient: exploding as never,
        jobClient: job.client as never,
      }),
    /service key sai/,
    "ngoại lệ phải nổi lên route như cũ, không bị nuốt",
  );
  assert.equal(job.rows.length, 1, "vẫn phải ghi sổ trước khi ném");
  assert.equal(job.rows[0].ok, false);
  assert.equal(
    (job.rows[0].detail as { error: string }).error,
    "exception",
    "phân biệt job-chạy-rồi-lỗi với job-không-chạy-nổi",
  );
});

// ── Ca nguồn ghi sổ hỏng ────────────────────────────────────────────────

test("ca ghi sổ lỗi DB: việc dọn clip vẫn trả kết quả nguyên vẹn", async () => {
  const { result } = await runJob(OK_FETCH, "db_error");
  assert.equal(result.ok, true, "insert sổ lỗi không được kéo job chết theo");
  assert.equal(result.ok && result.deleted, 0);
});

test("ca ghi sổ ném ngoại lệ: không rò ra ngoài", async () => {
  const { result } = await runJob(OK_FETCH, "throw");
  assert.equal(result.ok, true, "recordSystemJob không bao giờ throw");
});

test("ca ghi sổ hỏng khi job cũng lỗi: vẫn trả đúng lỗi của job", async () => {
  const { result } = await runJob(FAILED_FETCH, "throw");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "fetch_failed");
});

// ── Nửa âm: không rò dữ liệu khách vào bảng platform-global ─────────────

test("nửa âm: detail chỉ giữ SỐ LƯỢNG remove_errors, không giữ nội dung", async () => {
  // Có clip quá hạn + storage.remove lỗi → remove_errors có nội dung chứa
  // đường dẫn file (kèm id org, id clip). system_jobs không có
  // organization_id nên không được chứa dữ liệu định danh khách.
  const q: Record<string, unknown> = {
    select: () => q,
    not: () => q,
    lt: () => q,
    in: () => q,
    update: () => q,
    eq: () => q,
    then: (resolve: (v: unknown) => void) =>
      resolve({
        data: [{ id: "clip-1", packing_event_id: "ev-1", bucket_path: "org-abc/clip-1.mp4", bucket_uploaded_at: "2026-08-01T00:00:00Z" }],
        error: null,
      }),
  };
  const clip = {
    from: () => q,
    storage: {
      from: () => ({
        remove: async () => ({ error: { message: "not found: org-abc/clip-1.mp4" } }),
      }),
    },
  };
  const job = fakeJobClient("ok");
  const { runCleanupClipsJob } = await import("../src/lib/system/cleanup-clips-job.ts");
  const result = await runCleanupClipsJob({
    clipClient: clip as never,
    jobClient: job.client as never,
  });

  assert.equal(result.ok, true);
  assert.equal(job.rows.length, 1);
  const detail = job.rows[0].detail as { remove_errors: unknown };
  assert.equal(detail.remove_errors, 1, "đếm, không phải mảng thông điệp");
  assert.doesNotMatch(
    JSON.stringify(job.rows[0].detail),
    /org-abc/,
    "đường dẫn bucket (kèm id org) không được lọt vào bảng platform-global",
  );
});
