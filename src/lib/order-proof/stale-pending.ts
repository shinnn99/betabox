import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * Lớp 3 (backstop cuối) cho clip mồ côi ở trạng thái `pending`.
 *
 * Sự cố 2026-08-11 (SPXVN068642901568): agent cắt lỗi, callback
 * `/api/agent/clip-cut-result` trúng deployment Vercel cũ đã disable
 * (451) nên KHÔNG tới cloud, trong khi `/api/agent/command-result` lại
 * tới. Kết quả: `agent_commands.status='failed'` nhưng
 * `order_proof_clips.status='pending'` — UI hiện "Đang cắt" vĩnh viễn,
 * không có cả nút Thử lại. Không ai dọn vì:
 *   - /watch chỉ kiểm agent còn sống, KHÔNG kiểm tuổi row pending.
 *   - cron cleanup-clips chỉ dọn bucket theo TTL.
 *
 * Ba lớp bảo vệ, độc lập nhau (một lớp thủng thì lớp sau đỡ):
 *   1. Agent retry callback qua outbox (warehouse-agent/clip-result-outbox).
 *   2. Cloud reconcile ngay khi nhận `command-result` failed của cut_clip.
 *   3. Lớp này — quét theo tuổi, không cần callback nào tới cả.
 *
 * ĐIỀU KIỆN STALE (phải đủ CẢ HAI, không được chỉ một):
 *   a. Row pending già hơn ngưỡng (mặc định 5 phút).
 *   b. KHÔNG còn `agent_commands` type=cut_clip nào ở pending/taken cho
 *      packing event đó.
 * Vế (b) là vế quan trọng: agent còn sống KHÔNG chứng minh job cắt cụ
 * thể còn chạy, nhưng command còn `taken` thì CHỨNG MINH được. Nhờ vế
 * này, clip re-encode lâu (HEVC 10 phút) không bao giờ bị đánh nhầm —
 * chừng nào command chưa đóng thì row chưa bao giờ stale, kể cả quá
 * ngưỡng.
 */

/**
 * ⚠ BẤT BIẾN LIÊN PHIÊN BẢN — ĐỌC TRƯỚC KHI ĐỔI THỨ TỰ TRONG AGENT ⚠
 *
 * Lớp này an toàn với agent 0.8.8/0.8.9 vì agent báo `command-result`
 * (done/failed) **CUỐI CÙNG** — sau `promote_clip_generation` và sau
 * `clip-cut-result`. Nhờ vậy "còn command pending/taken" là bằng chứng
 * đủ mạnh cho "job cắt còn đang chạy", kể cả khi reaper kéo `taken` quá
 * 2 phút về `pending` (reap_stale_agent_commands) — cả hai trạng thái
 * đều được tính là đang chạy ở đây.
 *
 * NẾU một bản agent sau này đảo thứ tự (báo command xong TRƯỚC khi
 * promote), lớp này thành nguy hiểm: nó có thể đánh row sang 'failed'
 * trong lúc clip đã cắt + upload xong đang chờ promote, và RPC
 * `promote_clip_generation` RAISE `promote_new_bad_status` với mọi status
 * khác 'pending' → mất trắng một clip đã có sẵn trên bucket. Đổi thứ tự
 * đó thì phải đổi điều kiện ở đây trước.
 *
 * Tuổi tối thiểu của row pending trước khi được xét stale.
 *
 * 5 phút = ~23× happy path đo thật (cut ~0.5-1.3s + upload ~2-4s +
 * report, tổng ~13s cho command trọn vẹn). Dư rất nhiều cho mạng kho
 * chậm. Không hạ thấp hơn: hạ xuống thì ca "cloud chậm đóng command"
 * bắt đầu chạm ngưỡng, mà lợi ích không đổi (user vẫn phải chờ agent
 * xong mới xem được clip).
 */
export const STALE_PENDING_CLIP_MINUTES = Number(
  process.env.STALE_PENDING_CLIP_MINUTES ?? 5,
);

/**
 * Ghi vào `error_message` khi đánh dấu stale. Viết rõ NGUYÊN NHÂN suy
 * luận được ("không có lệnh cắt nào đang chạy"), KHÔNG viết mơ hồ kiểu
 * "timeout" — sau này audit lại phải phân biệt được row này bị lớp 3
 * dọn với row có lỗi thật do agent báo về.
 */
export const STALE_PENDING_ERROR_MESSAGE =
  "cut_orphan_no_active_command: agent không báo kết quả cắt và không còn lệnh cắt nào đang chạy";

export interface PendingClipCandidate {
  id: string;
  packingEventId: string;
  createdAt: string;
}

/**
 * Quyết định thuần (không I/O) — tách ra để test được cả hai vế mà
 * không cần DB.
 */
export function isStalePendingClip(args: {
  createdAt: string;
  nowMs: number;
  hasActiveCommand: boolean;
  thresholdMinutes?: number;
}): boolean {
  if (args.hasActiveCommand) return false;
  const createdMs = new Date(args.createdAt).getTime();
  // created_at không parse được → KHÔNG đánh stale. Thà treo còn hơn
  // đánh nhầm row đang cắt thật vì một chuỗi ngày rác.
  if (!Number.isFinite(createdMs)) return false;
  const thresholdMs =
    (args.thresholdMinutes ?? STALE_PENDING_CLIP_MINUTES) * 60 * 1000;
  return args.nowMs - createdMs >= thresholdMs;
}

/**
 * Đánh dấu failed cho các row pending đã mồ côi. Trả về Set id row THẬT
 * SỰ được update (lấy từ `select()` sau update, không phải danh sách
 * ứng viên) — caller dùng Set này để đồng bộ state trong RAM.
 *
 * An toàn khi chạy song song nhiều request: update có guard
 * `.eq("status","pending")` nên hai request cùng lúc thì chỉ một request
 * thấy row trong kết quả trả về.
 */
export async function reconcileStalePendingClips(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  candidates: PendingClipCandidate[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();

  // Lọc theo tuổi TRƯỚC khi query command — row mới tinh chiếm đa số,
  // không đáng một round-trip DB.
  const nowMs = Date.now();
  const aged = candidates.filter((c) =>
    isStalePendingClip({
      createdAt: c.createdAt,
      nowMs,
      hasActiveCommand: false,
    }),
  );
  if (aged.length === 0) return new Set();

  // Lệnh cắt đang chạy của org. Số row luôn nhỏ (pending/taken chỉ tồn
  // tại trong lúc agent xử lý) nên select thẳng payload rồi lọc trong
  // JS — không cần filter theo json path, tránh cú pháp PostgREST dễ vỡ.
  const { data: activeCommands, error: cmdErr } = await admin
    .from("agent_commands")
    .select("payload")
    .eq("organization_id", organizationId)
    .eq("type", "cut_clip")
    .in("status", ["pending", "taken"]);

  if (cmdErr) {
    // Không đọc được lệnh đang chạy = không chứng minh được vế (b).
    // Bỏ qua lượt này, KHÔNG đoán. Lần load sau sẽ thử lại.
    console.error(
      `[stale-pending] không đọc được agent_commands org=${organizationId}: ${cmdErr.message}`,
    );
    return new Set();
  }

  const activePeIds = new Set<string>();
  const activeClipIds = new Set<string>();
  for (const row of activeCommands ?? []) {
    const payload = row.payload as
      | { packing_event_id?: unknown; clip_id?: unknown }
      | null;
    if (typeof payload?.packing_event_id === "string") {
      activePeIds.add(payload.packing_event_id);
    }
    if (typeof payload?.clip_id === "string") {
      activeClipIds.add(payload.clip_id);
    }
  }

  const staleIds = aged
    .filter(
      (c) => !activePeIds.has(c.packingEventId) && !activeClipIds.has(c.id),
    )
    .map((c) => c.id);
  if (staleIds.length === 0) return new Set();

  const { data: updated, error: updErr } = await admin
    .from("order_proof_clips")
    .update({
      status: "failed",
      error_message: STALE_PENDING_ERROR_MESSAGE,
      progress_state: null,
    })
    .in("id", staleIds)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("id");

  if (updErr) {
    console.error(
      `[stale-pending] update failed org=${organizationId} ids=${staleIds.join(",")}: ${updErr.message}`,
    );
    return new Set();
  }

  const marked = new Set((updated ?? []).map((r) => r.id as string));
  if (marked.size > 0) {
    // Log ERROR chứ không log info: mỗi lần lớp 3 phải ra tay nghĩa là
    // lớp 1 và lớp 2 đều đã thủng — đó là tín hiệu cần điều tra, không
    // phải chuyện thường ngày.
    console.error(
      `[stale-pending] đánh dấu failed ${marked.size} clip mồ côi org=${organizationId} ids=${[...marked].join(",")}`,
    );
  }
  return marked;
}
