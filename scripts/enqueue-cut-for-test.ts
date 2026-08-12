/**
 * Kích một lệnh cut_clip cho ca kiểm agent — thay cho việc bấm nút
 * "Tạo clip" trên dashboard.
 *
 * Chạy:
 *   node --import ./tests/register.mjs --conditions=react-server \
 *        --experimental-strip-types --env-file=.env.local \
 *        scripts/enqueue-cut-for-test.ts <packing_event_id>
 *
 * Vì sao gọi `enqueueCutClip` chứ không tự INSERT hay tự gọi RPC: mọi
 * tham số cắt (biên clip, pre/post seconds, end_reason, danh sách
 * segment) do resolver phía cloud tính. Dựng lại bằng tay là kiểm một
 * đường khác với đường thật — ca kiểm sẽ xanh cho một thứ không ai chạy.
 * Đây đúng là hàm mà /watch gọi khi user bấm "Tạo clip".
 *
 * KHÔNG dùng cho vận hành. Chỉ để dựng ca kiểm trên máy demo.
 */
import { createClient } from "@supabase/supabase-js";
import { enqueueCutClip } from "@/lib/agent-commands/enqueue";

const peId = process.argv[2];
if (!peId) {
  console.error("Thiếu tham số: <packing_event_id>");
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: pe, error: peErr } = await admin
  .from("packing_events")
  .select("id, organization_id, waybill_code, timing_status")
  .eq("id", peId)
  .maybeSingle();

if (peErr || !pe) {
  console.error(`Không tìm thấy packing_event ${peId}: ${peErr?.message ?? "null"}`);
  process.exit(1);
}

// Agent của org — lấy cái đang active, giống cách /watch chọn qua liveness.
const { data: agent, error: agErr } = await admin
  .from("warehouse_agents")
  .select("id, code, last_seen_at")
  .eq("organization_id", pe.organization_id)
  .eq("status", "active")
  .order("last_seen_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (agErr || !agent) {
  console.error(`Org ${pe.organization_id} không có agent active`);
  process.exit(1);
}

const seenAgoSec = agent.last_seen_at
  ? Math.round((Date.now() - new Date(agent.last_seen_at).getTime()) / 1000)
  : null;

console.log(
  `PE ${pe.waybill_code} (${pe.timing_status}) → agent ${agent.code}, heartbeat cách đây ${seenAgoSec ?? "?"}s`,
);

const result = await enqueueCutClip({
  organizationId: pe.organization_id,
  agentId: agent.id,
  packingEventId: pe.id,
  replacesClipId: null,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
