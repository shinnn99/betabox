import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Dung lượng video trên Supabase Storage (/platform/storage).
 *
 * Ba tính chất đáng khoá lại bằng test, vì cả ba đều là chỗ đã có bằng chứng
 * sai thật trong dữ liệu production ngày 02/10/2026:
 *
 *   1. TỔNG đi từ `storage.objects`, KHÔNG đi từ `order_proof_clips`. Số thật
 *      hôm đó: bucket 34 object/1421 MB, bảng clip chỉ nhận 31/1354 MB. Cộng
 *      theo bảng clip là tự bớt 67 MB khỏi hoá đơn mình đang trả.
 *   2. Object mồ côi KHÔNG bị loại khỏi tổng — nó vào nhóm "không rõ chủ".
 *      Loại đi thì con số đẹp hơn và sai hơn.
 *   3. Hàm RPC chưa có → `available:false`, TUYỆT ĐỐI không trả 0 byte.
 *      "0 byte" đọc y hệt một bucket rỗng, mà sự thật là chưa đo được.
 */

interface StubRow {
  name: string;
  size_bytes: number;
  created_at: string;
}

interface StubOpts {
  objects?: StubRow[];
  rpcError?: { code?: string; message: string };
  clips?: Array<{ bucket_path: string; organization_id: string; waybill_code: string | null }>;
  orgs?: Array<{ id: string; name: string }>;
}

/**
 * Admin client giả. `from()` trả thenable nên `await` ra {data,error}; `rpc()`
 * trả thẳng danh sách object.
 */
function fakeAdmin(o: StubOpts) {
  const table = (rows: unknown[]) => {
    const q: Record<string, unknown> = {
      select: () => q,
      not: () => q,
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
    };
    return q;
  };
  return {
    rpc: async () =>
      o.rpcError
        ? { data: null, error: o.rpcError }
        : { data: o.objects ?? [], error: null },
    from: (t: string) =>
      t === "order_proof_clips" ? table(o.clips ?? []) : table(o.orgs ?? []),
  };
}

const ORG = "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8";
const NOW_ISO = new Date().toISOString();

async function run(o: StubOpts) {
  const { readStorageUsage } = await import("../src/lib/system/storage-usage.ts");
  return readStorageUsage(fakeAdmin(o) as never);
}

test("tổng đi từ storage.objects, gồm cả file bảng clip không biết", async () => {
  const usage = await run({
    objects: [
      { name: `${ORG}/a.mp4`, size_bytes: 100, created_at: NOW_ISO },
      // Mồ côi: không dòng clip nào trỏ tới.
      { name: `${ORG}/orphan.mp4`, size_bytes: 67, created_at: NOW_ISO },
    ],
    clips: [{ bucket_path: `${ORG}/a.mp4`, organization_id: ORG, waybill_code: "VD1" }],
    orgs: [{ id: ORG, name: "Kho Đại Kim" }],
  });

  assert.equal(usage.available, true);
  if (!usage.available) return;
  assert.equal(usage.totalBytes, 167, "tổng phải gồm cả file mồ côi");
  assert.equal(usage.accountedBytes, 100, "phần gán được chủ chỉ là 100");
  assert.equal(usage.orphanObjects, 1);
  assert.equal(usage.orphanBytes, 67);
});

test("file mồ côi vào nhóm 'không rõ chủ', không bị loại khỏi bảng theo kho", async () => {
  const usage = await run({
    objects: [
      { name: `${ORG}/a.mp4`, size_bytes: 100, created_at: NOW_ISO },
      { name: "lac/orphan.mp4", size_bytes: 67, created_at: NOW_ISO },
    ],
    clips: [{ bucket_path: `${ORG}/a.mp4`, organization_id: ORG, waybill_code: "VD1" }],
    orgs: [{ id: ORG, name: "Kho Đại Kim" }],
  });
  assert.equal(usage.available, true);
  if (!usage.available) return;

  const orphanRow = usage.orgs.find((r) => r.orgId === null);
  assert.ok(orphanRow, "phải có một dòng cho nhóm không rõ chủ");
  assert.equal(orphanRow.bytes, 67);
  assert.equal(
    usage.orgs.reduce((n, r) => n + r.bytes, 0),
    usage.totalBytes,
    "cộng các dòng theo kho phải bằng đúng tổng — không dòng nào bị bỏ",
  );
});

test("hàm RPC chưa có → available:false kèm tên migration, KHÔNG phải 0 byte", async () => {
  const usage = await run({ rpcError: { code: "42883", message: "function does not exist" } });
  assert.equal(usage.available, false);
  if (usage.available) return;
  assert.match(usage.reason, /migration/i, `phải chỉ ra migration cần chạy; thực tế: ${usage.reason}`);
});

test("lỗi đọc khác → available:false, không nuốt thành bucket rỗng", async () => {
  const usage = await run({ rpcError: { message: "connection reset" } });
  assert.equal(usage.available, false);
});

test("file quá hạn 72h bị đếm riêng — dấu hiệu lượt dọn đã chết", async () => {
  const old = new Date(Date.now() - 100 * 3600_000).toISOString();
  const usage = await run({
    objects: [
      { name: `${ORG}/old.mp4`, size_bytes: 10, created_at: old },
      { name: `${ORG}/new.mp4`, size_bytes: 10, created_at: NOW_ISO },
    ],
    clips: [],
    orgs: [{ id: ORG, name: "Kho Đại Kim" }],
  });
  assert.equal(usage.available, true);
  if (!usage.available) return;
  assert.equal(usage.overdueObjects, 1, "đúng 1 file quá hạn");
  const oldRow = usage.objects.find((o) => o.path.endsWith("old.mp4"));
  assert.ok(oldRow && oldRow.hoursLeft < 0, "file quá hạn phải có hoursLeft âm");
});
