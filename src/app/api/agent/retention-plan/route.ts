import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAgentHeaders, verifyAgentRequest } from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Danh sách segment thuần hàng hoàn để agent xoá sớm (7 ngày thay vì 35).
 *
 * Vì sao cloud lập danh sách chứ không để agent tự quyết: chỉ cloud biết
 * một đoạn video 60 giây được ghi lúc bàn ở chế độ nào, camera lúc đó gắn
 * bàn nào, và đoạn đó có nằm trong cửa sổ video của đơn đi nào không. Agent
 * chỉ có file trên ổ đĩa.
 *
 * Script xoá chạy KHÔNG gọi mạng (Task Scheduler, có thể chạy lúc agent
 * chết), nên agent ghi danh sách này xuống file cache local.
 *
 * Thiếu hoặc hỏng cache → script chỉ xoá theo hạn chung. Không bao giờ vì
 * lỗi mà xoá rộng hơn.
 */

/** Trần số file mỗi lần trả — cache local không nên phình vô hạn. */
const MAX_FILES = 5000;

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) return NextResponse.json({ error: "missing_headers" }, { status: 400 });

  const rawBody = await req.text();

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
    .eq("code", headers.code)
    .maybeSingle();
  if (agentErr) return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.retentionPlan,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Phân loại ngay tại đây thay vì cần thêm một cron: agent hỏi danh sách
  // mỗi vài giờ, và đó đúng là lúc cần danh sách mới nhất.
  const { error: classifyErr } = await admin.rpc("classify_return_segments", {
    p_organization_id: agent.organization_id,
  });
  if (classifyErr) {
    console.warn(
      `[retention-plan] phân loại segment lỗi org=${agent.organization_id}: ${classifyErr.message}`,
    );
  }

  // Số ngày: ưu tiên cấu hình cấp tổ chức (ô trên trang Cấu hình kho, thêm
  // 23/09/2026), rồi mới tới config kho cũ, cuối cùng mặc định 7 ngày.
  const [{ data: org }, { data: warehouses }] = await Promise.all([
    admin
      .from("organizations")
      .select("return_retention_days")
      .eq("id", agent.organization_id)
      .maybeSingle(),
    admin
      .from("warehouses")
      .select("packing_timing_config")
      .eq("organization_id", agent.organization_id)
      .limit(1),
  ]);
  const cfg = (warehouses?.[0]?.packing_timing_config ?? null) as Record<string, unknown> | null;
  const orgDays = Number(org?.return_retention_days);
  const rawDays = Number.isFinite(orgDays) && orgDays > 0
    ? orgDays
    : Number(cfg?.return_segment_retention_days);
  const returnRetentionDays =
    Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.floor(rawDays) : 7;

  // Chỉ trả file đã đủ già để sắp bị xoá; danh sách ngắn thì cache nhẹ và
  // script chạy nhanh. Lùi thêm một ngày để không phụ thuộc giờ chạy.
  //
  // Có cận DƯỚI vì bản ghi `camera_recording_files` không bị xoá khi agent
  // xoá file trên ổ đĩa (script chạy offline, không báo về). Không có cận
  // dưới thì danh sách xếp từ cũ nhất sẽ dần toàn file đã xoá từ lâu và
  // chiếm hết trần — file mới quá hạn không bao giờ lọt vào, cleanup âm
  // thầm ngừng tác dụng. Cửa sổ 30 ngày: script chạy hằng ngày nên quá
  // thừa, còn nếu máy tắt lâu hơn thế thì phần rơi ra ngoài vẫn được xoá
  // theo hạn chung — giữ lâu hơn chứ không mất.
  const cutoff = new Date(Date.now() - (returnRetentionDays - 1) * 86_400_000).toISOString();
  const windowStart = new Date(
    Date.now() - (returnRetentionDays + 30) * 86_400_000,
  ).toISOString();
  const { data: files, error: filesErr } = await admin
    .from("camera_recording_files")
    .select("file_path")
    .eq("organization_id", agent.organization_id)
    .eq("retention_class", "return_short")
    .lt("started_at", cutoff)
    .gt("started_at", windowStart)
    .order("started_at", { ascending: true })
    .limit(MAX_FILES);

  if (filesErr) {
    return NextResponse.json({ error: "list_failed", message: filesErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    return_retention_days: returnRetentionDays,
    files: (files ?? []).map((f) => f.file_path as string),
  });
}
