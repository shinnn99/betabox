import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";
import {
  chunk,
  planRecordingFileWrites,
  type ExistingRecordingFile,
} from "@/lib/warehouse/recording-files-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo segment index về cloud. Batch: một request có thể mang
 * nhiều file — boot recovery thường gửi 20+ file cùng lúc, đỡ round-trip.
 *
 * Upsert theo (organization_id, camera_id, file_path). Ca collision
 * tên file trong CÙNG camera cực hiếm (backoff respawn 2s + segment
 * 60s không thể trùng giây) — nhưng nếu xảy ra, KHÔNG cho ghi đè row
 * đã có ended_at (nghĩa là segment đã đóng, ghi đè sẽ mất dữ liệu). Log
 * 'segment_collision' để ops nhìn thấy — nếu thấy warn này cần đổi
 * ffmpeg pattern thêm %3N (millisecond).
 *
 * Multi-tenant guard: camera_id phải thuộc org của agent (lấy từ HMAC
 * identity, không tin body). Camera không thuộc org bị bỏ qua lặng
 * lẽ trong summary, không leak.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FilePayload {
  camera_id: string;
  session_id: string | null;
  file_path: string;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
}

type ParseOutcome =
  | { ok: true; files: FilePayload[] }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const files = r.files;
  if (!Array.isArray(files)) return { ok: false, error: "files_required" };
  if (files.length === 0) return { ok: false, error: "files_empty" };
  if (files.length > 200) return { ok: false, error: "too_many_files" };

  const out: FilePayload[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") return { ok: false, error: "file_invalid" };
    const x = f as Record<string, unknown>;

    const cameraId = typeof x.camera_id === "string" ? x.camera_id.trim() : "";
    if (!UUID_RE.test(cameraId)) return { ok: false, error: "camera_id_invalid" };

    const sessionRaw = x.session_id;
    let sessionId: string | null = null;
    if (typeof sessionRaw === "string" && sessionRaw.trim()) {
      if (!UUID_RE.test(sessionRaw.trim())) {
        return { ok: false, error: "session_id_invalid" };
      }
      sessionId = sessionRaw.trim();
    }

    const filePath = typeof x.file_path === "string" ? x.file_path.trim() : "";
    if (!filePath) return { ok: false, error: "file_path_required" };
    // Chặn path traversal — agent luôn gửi relative path dạng
    // "cam_code/YYYY/MM/DD/name.mp4". Reject anything với ".." hoặc
    // absolute path.
    if (filePath.includes("..") || filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) {
      return { ok: false, error: "file_path_traversal" };
    }

    const fileName = typeof x.file_name === "string" ? x.file_name.trim() : "";
    if (!fileName) return { ok: false, error: "file_name_required" };

    const startedAt = typeof x.started_at === "string" ? x.started_at.trim() : "";
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) {
      return { ok: false, error: "started_at_invalid" };
    }

    let endedAt: string | null = null;
    if (x.ended_at !== null && x.ended_at !== undefined) {
      const e = typeof x.ended_at === "string" ? x.ended_at.trim() : "";
      if (!e || !Number.isFinite(Date.parse(e))) {
        return { ok: false, error: "ended_at_invalid" };
      }
      endedAt = e;
    }

    let duration: number | null = null;
    if (x.duration_seconds !== null && x.duration_seconds !== undefined) {
      const d = Number(x.duration_seconds);
      if (!Number.isFinite(d) || d < 0) {
        return { ok: false, error: "duration_seconds_invalid" };
      }
      duration = Math.round(d);
    }

    let size: number | null = null;
    if (x.file_size_bytes !== null && x.file_size_bytes !== undefined) {
      const s = Number(x.file_size_bytes);
      if (!Number.isFinite(s) || s < 0) {
        return { ok: false, error: "file_size_bytes_invalid" };
      }
      size = Math.round(s);
    }

    out.push({
      camera_id: cameraId,
      session_id: sessionId,
      file_path: filePath,
      file_name: fileName,
      started_at: startedAt,
      ended_at: endedAt,
      duration_seconds: duration,
      file_size_bytes: size,
    });
  }

  return { ok: true, files: out };
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseBody(json);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
    .eq("code", headers.code)
    .maybeSingle();

  if (agentErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  }
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.recordingFiles,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Multi-tenant filter: lấy set camera thuộc org agent, drop file
  // trỏ camera ngoài org (lặng lẽ, không leak).
  const cameraIds = Array.from(new Set(parsed.files.map((f) => f.camera_id)));
  const { data: cams, error: camErr } = await admin
    .from("cameras")
    .select("id")
    .in("id", cameraIds)
    .eq("organization_id", agent.organization_id);
  if (camErr) {
    return NextResponse.json(
      { error: "lookup_failed", message: camErr.message },
      { status: 500 },
    );
  }
  const allowedCameras = new Set((cams ?? []).map((c) => c.id));

  // Gộp lô (2026-08-12). Trước đây vòng lặp từng file: 1 SELECT +
  // 1 upsert mỗi file → lô 50 file = 100 round-trip PostgREST cho MỘT
  // request. Đo bằng pg_stat_statements: cặp query của bảng này chiếm
  // 64,5% tổng số lượt gọi của cả project. Giờ: 1 SELECT + 1 upsert
  // mỗi 100 phần tử.
  //
  // Luật collision KHÔNG đổi — chỉ chuyển từ hỏi-từng-dòng sang
  // hỏi-một-lượt rồi quyết trong JS (planRecordingFileWrites).
  const distinctPaths = [...new Set(parsed.files.map((f) => f.file_path))];
  const existing: ExistingRecordingFile[] = [];
  for (const paths of chunk(distinctPaths)) {
    const { data, error: exErr } = await admin
      .from("camera_recording_files")
      .select("camera_id, file_path, ended_at")
      .eq("organization_id", agent.organization_id)
      .in("file_path", paths);
    if (exErr) {
      return NextResponse.json(
        { error: "lookup_failed", message: exErr.message },
        { status: 500 },
      );
    }
    existing.push(...((data ?? []) as ExistingRecordingFile[]));
  }

  const plan = planRecordingFileWrites({
    organizationId: agent.organization_id,
    files: parsed.files,
    allowedCameraIds: allowedCameras,
    existing,
  });
  const skipped = plan.skippedOutOfOrg;
  const collisions = plan.collisions;

  // Lỗi giữa chừng → cả lô chưa ghi hết. Agent đẩy nguyên lô về hàng
  // đợi khi thấy !ok (segment-index.ts flushQueue/reportBatch) nên
  // không mất bản ghi nào; upsert là idempotent theo khoá UNIQUE nên
  // gửi lại phần đã ghi cũng vô hại.
  for (const rows of chunk(plan.rows)) {
    const { error: upErr } = await admin
      .from("camera_recording_files")
      .upsert(rows, { onConflict: "organization_id,camera_id,file_path" });
    if (upErr) {
      return NextResponse.json(
        { error: "upsert_failed", message: upErr.message, batch_size: rows.length },
        { status: 500 },
      );
    }
  }

  await admin
    .from("warehouse_agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", agent.id);

  return NextResponse.json({
    ok: true,
    upserted: plan.rows.length,
    skipped_out_of_org: skipped.length,
    collisions,
  });
}
