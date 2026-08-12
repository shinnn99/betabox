import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStalePendingClip,
  reconcileStalePendingClips,
  STALE_PENDING_ERROR_MESSAGE,
} from "../src/lib/order-proof/stale-pending.ts";

/**
 * Lớp 3: clip mồ côi ở 'pending'.
 *
 * Ca gốc đã cắn thật (2026-08-11, SPXVN068642901568, kho Đại Kim):
 * agent cắt lỗi, callback /clip-cut-result trúng deployment Vercel cũ
 * đã disable (451) nên không tới cloud, còn /command-result thì tới.
 * Row clip kẹt 'pending' 43 phút cho tới khi điều tra tay — UI hiện
 * "Đang cắt" và KHÔNG có nút Thử lại.
 *
 * Verify HAI NỬA:
 *   - nửa dương-đúng: row già + không còn lệnh cắt → BỊ đánh failed.
 *   - nửa âm-đúng: row mới, hoặc row già NHƯNG còn lệnh cắt đang chạy
 *     → KHÔNG bị đụng. Vế sau là vế dễ hỏng nhất: nếu sai, clip
 *     re-encode lâu (HEVC 10 phút) sẽ bị giết giữa chừng.
 */

const NOW = Date.parse("2026-08-11T09:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
// reconcile* đọc Date.now() thật (không nhận nowMs), nên fixture của
// phần đó phải tính theo giờ thật — dùng NOW cố định thì row "1 phút
// trước" hoá ra già hàng chục tiếng và test tự xanh sai lý do.
const realMinutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

test("nửa dương: pending quá 5 phút + không còn lệnh cắt → stale", () => {
  assert.equal(
    isStalePendingClip({
      createdAt: minutesAgo(6),
      nowMs: NOW,
      hasActiveCommand: false,
    }),
    true,
  );
});

test("nửa âm: pending còn mới → KHÔNG stale dù không có lệnh nào", () => {
  assert.equal(
    isStalePendingClip({
      createdAt: minutesAgo(1),
      nowMs: NOW,
      hasActiveCommand: false,
    }),
    false,
  );
});

test("nửa âm: còn lệnh cắt đang chạy → KHÔNG stale dù đã 3 tiếng", () => {
  // Ca re-encode HEVC dài: command vẫn 'taken', agent vẫn đang cắt.
  // Đánh stale ở đây = giết job đang chạy thật.
  assert.equal(
    isStalePendingClip({
      createdAt: minutesAgo(180),
      nowMs: NOW,
      hasActiveCommand: true,
    }),
    false,
  );
});

test("created_at rác → KHÔNG stale (thà treo còn hơn đánh nhầm)", () => {
  assert.equal(
    isStalePendingClip({
      createdAt: "không-phải-ngày",
      nowMs: NOW,
      hasActiveCommand: false,
    }),
    false,
  );
});

// ---------- reconcile: nối dây thật với DB (admin client giả) ----------

interface FakeCall {
  updatePatch?: Record<string, unknown>;
  updateIds?: string[];
  commandQueried: boolean;
}

function fakeAdmin(
  activeCommands: Array<{ payload: Record<string, unknown> }>,
  calls: FakeCall,
) {
  const commandBuilder = {
    select: () => commandBuilder,
    eq: () => commandBuilder,
    in: () => {
      calls.commandQueried = true;
      return Promise.resolve({ data: activeCommands, error: null });
    },
  };
  const clipBuilder = {
    update(patch: Record<string, unknown>) {
      calls.updatePatch = patch;
      return clipBuilder;
    },
    in(_col: string, ids: string[]) {
      calls.updateIds = ids;
      return clipBuilder;
    },
    eq: () => clipBuilder,
    select: () =>
      Promise.resolve({
        data: (calls.updateIds ?? []).map((id) => ({ id })),
        error: null,
      }),
  };
  return {
    from(table: string) {
      if (table === "agent_commands") return commandBuilder;
      if (table === "order_proof_clips") return clipBuilder;
      throw new Error(`bảng không mong đợi: ${table}`);
    },
  };
}

const ORG = "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8";
const PE = "ab03ab03-b732-493b-8446-99cda28094ca";
const CLIP = "6f60fda4-f87d-4ec9-934a-5276f5a8c478";

test("ca SPXVN068642901568: không còn lệnh → clip bị đóng thành failed", async () => {
  const calls: FakeCall = { commandQueried: false };
  const admin = fakeAdmin([], calls);
  const marked = await reconcileStalePendingClips(
    admin as never,
    ORG,
    [{ id: CLIP, packingEventId: PE, createdAt: realMinutesAgo(40) }],
  );
  assert.deepEqual([...marked], [CLIP]);
  assert.deepEqual(calls.updateIds, [CLIP]);
  assert.equal(calls.updatePatch?.status, "failed");
  assert.equal(calls.updatePatch?.error_message, STALE_PENDING_ERROR_MESSAGE);
  // progress_state phải được dọn, nếu không UI còn đọc 'encoding' cũ.
  assert.equal(calls.updatePatch?.progress_state, null);
});

test("còn lệnh cut_clip pending/taken cùng pe → KHÔNG update gì", async () => {
  const calls: FakeCall = { commandQueried: false };
  const admin = fakeAdmin([{ payload: { packing_event_id: PE } }], calls);
  const marked = await reconcileStalePendingClips(
    admin as never,
    ORG,
    [{ id: CLIP, packingEventId: PE, createdAt: realMinutesAgo(40) }],
  );
  assert.equal(marked.size, 0);
  assert.equal(calls.updateIds, undefined, "không được gọi update");
});

test("lệnh khớp theo clip_id (khác pe) cũng chặn được stale", async () => {
  const calls: FakeCall = { commandQueried: false };
  const admin = fakeAdmin([{ payload: { clip_id: CLIP } }], calls);
  const marked = await reconcileStalePendingClips(
    admin as never,
    ORG,
    [{ id: CLIP, packingEventId: PE, createdAt: realMinutesAgo(40) }],
  );
  assert.equal(marked.size, 0);
  assert.equal(calls.updateIds, undefined);
});

test("row còn mới → không tốn cả query agent_commands", async () => {
  const calls: FakeCall = { commandQueried: false };
  const admin = fakeAdmin([], calls);
  const marked = await reconcileStalePendingClips(
    admin as never,
    ORG,
    [{ id: CLIP, packingEventId: PE, createdAt: realMinutesAgo(1) }],
  );
  assert.equal(marked.size, 0);
  assert.equal(
    calls.commandQueried,
    false,
    "list load bình thường không được thêm query",
  );
});
