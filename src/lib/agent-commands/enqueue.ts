import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveClipBounds, type SegmentFile } from "@/lib/order-proof/clip-resolver";

// GOP pad bù keyframe snap khi `-c copy`. Cùng con số với code cũ
// (clip-cutter.ts GOP_PAD_BEFORE/AFTER_SECONDS=3). Tính ở cloud, gửi
// sẵn cho agent — agent không biết nghiệp vụ, chỉ cắt đúng khoảng
// nhận được.
const GOP_PAD_BEFORE_SECONDS = 3;
const GOP_PAD_AFTER_SECONDS = 3;

// Ngưỡng "gap" giữa hai segment liên tiếp (ms). Segment N+1.started_at
// - N.ended_at > ngưỡng này = có gap thật (camera offline, respawn
// chậm). Dưới ngưỡng coi là liền mạch (roll bình thường có thể lệch
// vài ms).
//
// Gap phát hiện được feed vào `order_proof_clips.is_partial` +
// `covered_range` + `total_gap_seconds` — dashboard hiện "clip thiếu
// N giây". Chỉ ghi nhận dữ liệu ở panel, KHÔNG vẽ gì lên video
// (chốt 2026-07-05: video thuần copy-stream, không burn, không
// overlay, không mark).
const GAP_DETECT_THRESHOLD_MS = 500;

/**
 * Producer cho kênh cloud → agent. Chèn job vào agent_commands.
 *
 * BLOCKS-GO-LIVE: producer CHƯA verify camera_recording_sessions.status
 * trước khi enqueue start_recording. Nếu cloud enqueue start cho camera
 * X trong khi camera X đang có session 'recording' của agent khác, ta
 * chỉ dựa vào:
 *   1) partial unique index idx_one_active_recording_per_camera trong
 *      camera_recording_sessions — chặn tạo session thứ hai ở DB.
 *   2) idempotent-guard per-process ở phía agent — chặn double-spawn
 *      trong CÙNG một agent.
 * Ca hai agent + cả hai spawn ffmpeg trước khi động vào session table:
 * KHÔNG chặn được. Trước khi vận hành >1 agent thật, thêm ở đây một
 * select trên camera_recording_sessions kiểm status='recording' → trả
 * lỗi conflict nếu đã có agent khác đang ghi camera này.
 */
export interface EnqueueStartRecordingArgs {
  organizationId: string;
  agentId: string;
  cameraId: string;
  sessionId: string;
}

export interface EnqueueStopRecordingArgs {
  organizationId: string;
  agentId: string;
  cameraId: string;
  sessionId: string;
}

export async function enqueueStartRecording(
  args: EnqueueStartRecordingArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "start_recording",
      payload: {
        camera_id: args.cameraId,
        session_id: args.sessionId,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue start_recording failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * B4 HIGH-12: transactional Start Recording qua RPC `enqueue_start_recording`.
 *
 * RPC dùng pg_advisory_xact_lock per camera_id (blocking) + check session
 * (recording, connection_lost) + command (pending, taken). Chống race
 * double-click / 2 tab tạo 2 session/command.
 *
 * Verdicts:
 *   - 'created' → tạo mới, trả session_id + command_id.
 *   - 'already_recording' → session recording đang chạy, trả session_id.
 *   - 'recording_state_unknown' → session connection_lost, reason chi tiết.
 *   - 'start_pending' → command pending/taken, trả command_id.
 */
export interface EnqueueStartRecordingV2Args {
  organizationId: string;
  cameraId: string;
  agentId: string;
  createdBy: string | null;
  transport: "tcp" | "udp";
  segmentSeconds: number;
  outputDir: string;
}

export type StartRecordingVerdict =
  | { verdict: "created"; session_id: string; command_id: string }
  | { verdict: "already_recording"; session_id: string }
  | { verdict: "recording_state_unknown"; session_id: string; reason: string }
  | { verdict: "start_pending"; command_id: string };

export async function enqueueStartRecordingV2(
  args: EnqueueStartRecordingV2Args,
): Promise<StartRecordingVerdict> {
  const admin = createAdminClient();

  // SET LOCAL lock_timeout + statement_timeout — nếu RPC chờ lock quá 3s,
  // return lỗi có mã rõ để client retry an toàn. Note: SET LOCAL chỉ áp
  // trong tx; Supabase JS client per-request tx wrapper không expose GUC.
  // Chấp nhận: lock_timeout default (không set), statement_timeout default.
  // Nếu cần enforce, wrap qua `pg` client trực tiếp — không làm trong B4.

  const { data, error } = await admin.rpc("enqueue_start_recording", {
    p_organization_id: args.organizationId,
    p_camera_id: args.cameraId,
    p_agent_id: args.agentId,
    p_created_by: args.createdBy,
    p_transport: args.transport,
    p_segment_seconds: args.segmentSeconds,
    p_output_dir: args.outputDir,
  });
  if (error) {
    throw new Error(`enqueue_start_recording RPC failed: ${error.message}`);
  }
  // RPC RETURNS TABLE trả array. Đọc row đầu.
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as
    | {
        verdict: string;
        session_id: string | null;
        command_id: string | null;
        reason: string | null;
      }
    | undefined;
  if (!row) {
    throw new Error("enqueue_start_recording RPC returned no row");
  }
  switch (row.verdict) {
    case "created":
      return {
        verdict: "created",
        session_id: row.session_id!,
        command_id: row.command_id!,
      };
    case "already_recording":
      return {
        verdict: "already_recording",
        session_id: row.session_id!,
      };
    case "recording_state_unknown":
      return {
        verdict: "recording_state_unknown",
        session_id: row.session_id!,
        reason: row.reason ?? "unknown",
      };
    case "start_pending":
      return {
        verdict: "start_pending",
        command_id: row.command_id!,
      };
    default:
      throw new Error(`unknown verdict: ${row.verdict}`);
  }
}

export async function enqueueStopRecording(
  args: EnqueueStopRecordingArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "stop_recording",
      payload: {
        camera_id: args.cameraId,
        session_id: args.sessionId,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue stop_recording failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * Cut clip = luôn copy-stream, không burn/vẽ/overlay (chốt 2026-07-05).
 * Video thuần. Cảnh báo gap cho vận hành: dashboard đọc
 * `order_proof_clips.is_partial` + `covered_range` + `total_gap_seconds`
 * (đã set trong payload xuống agent → callback clip-cut-result → row
 * DB) và hiện ở panel thông tin đơn cạnh video, không đè lên hình.
 */
export interface EnqueueCutClipArgs {
  organizationId: string;
  agentId: string;
  packingEventId: string;
  /**
   * Safe-retry 2026-07-06: khi user bấm [Thử lại] và hiện có clip ready
   * cần bảo toàn, endpoint retry truyền ID clip cũ vào đây. Agent nhìn
   * flag này để KHÔNG idempotent-reuse file canonical cũ — luôn cắt
   * generation mới vào temp file, chỉ promote sau khi upload+verify OK.
   *
   * null/undefined = lần cắt đầu (chưa có ready) hoặc recovery.
   */
  replacesClipId?: string | null;
}

export interface EnqueueCutClipResult {
  ok: true;
  command_id: string;
  /** ID row order_proof_clips (status='pending') vừa pre-insert. */
  clip_id: string;
  is_partial: boolean;
  segment_count: number;
}

export interface EnqueueCutClipFailure {
  ok: false;
  reason: "no_camera" | "no_segments" | "segment_still_open" | "internal" | "not_found";
  message: string;
}

export interface EnqueueUploadClipArgs {
  organizationId: string;
  agentId: string;
  packingEventId: string;
  bucketPath: string;
}

/**
 * 1.2: enqueue probe_codec cho camera. Agent build RTSP từ credential
 * có sẵn (KHÔNG gửi credential qua payload — nguyên tắc từ Lát 2), gọi
 * probeCodec, report result qua command-result. Callback ghi vào
 * cameras.codec_detected + codec_warning + codec_probed_at.
 */
export interface EnqueueProbeCodecArgs {
  organizationId: string;
  agentId: string;
  cameraId: string;
}

export async function enqueueProbeCodec(
  args: EnqueueProbeCodecArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "probe_codec",
      payload: {
        camera_id: args.cameraId,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue probe_codec failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * Lát 2 SaaS refactor: enqueue test_camera_connection cho camera đã save.
 * Agent build RTSP từ credential, chạy ffmpeg thử connect, report ok/fail.
 */
export interface EnqueueTestCameraConnectionArgs {
  organizationId: string;
  agentId: string;
  cameraId: string;
  transport?: "tcp" | "udp" | "auto";
}

export async function enqueueTestCameraConnection(
  args: EnqueueTestCameraConnectionArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "test_camera_connection",
      payload: {
        camera_id: args.cameraId,
        transport: args.transport ?? "auto",
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue test_camera_connection failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * Lát 2 SaaS refactor: enqueue snapshot_camera. Agent capture 1 JPEG frame,
 * upload lên bucket camera-snapshots-transient, callback với bucket_path.
 * Cloud cấp signed URL cho UI.
 */
export interface EnqueueSnapshotCameraArgs {
  organizationId: string;
  agentId: string;
  cameraId: string;
  bucketPath: string;
  transport?: "tcp" | "udp" | "auto";
}

export async function enqueueSnapshotCamera(
  args: EnqueueSnapshotCameraArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "snapshot_camera",
      payload: {
        camera_id: args.cameraId,
        bucket_path: args.bucketPath,
        transport: args.transport ?? "auto",
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue snapshot_camera failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * Lát 2 SaaS refactor: enqueue test_camera_draft cho camera CHƯA save.
 * Onboard flow "Tự tìm camera": user điền IP+port+creds → cần verify trước save.
 *
 * Credential ĐI QUA payload nhưng CHẤP NHẬN được vì:
 *   - Command chỉ sống tới khi agent xử xong (<10s).
 *   - Agent claim + verify HMAC → chỉ agent đúng org đọc được.
 *   - Sau khi agent report, endpoint có thể xóa row luôn.
 *
 * Vẫn cẩn thận: KHÔNG log payload này ra console/audit.
 */
export interface EnqueueTestCameraDraftArgs {
  organizationId: string;
  agentId: string;
  ip: string;
  rtspPort: number;
  username: string;
  password: string | null;
  rtspPath: string;
  transport?: "tcp" | "udp" | "auto";
}

export async function enqueueTestCameraDraft(
  args: EnqueueTestCameraDraftArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "test_camera_draft",
      payload: {
        ip: args.ip,
        rtsp_port: args.rtspPort,
        username: args.username,
        password: args.password,
        rtsp_path: args.rtspPath,
        transport: args.transport ?? "auto",
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue test_camera_draft failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * LAN discovery: enqueue job quét camera trên mạng nội bộ của kho.
 *
 * Trước đây scan chạy trực tiếp trên Next.js server. Đúng khi backend
 * còn nằm cùng LAN với camera; sai khi lên SaaS (Vercel POP không thấy
 * 192.168.x của kho). Chuyển sang command-queue: cloud enqueue, agent
 * chạy `scanForCameras` local rồi callback qua command-result.
 *
 * Payload:
 *   - mode: "quick" | "full" — copy nghĩa từ scanForCameras.
 *   - subnets: null → agent tự dùng listCandidateSubnets(); nếu có →
 *     agent scan chính xác list này (đã validate ở caller).
 *
 * Kết quả agent report:
 *   { scan_mode, scanned_subnets, available_subnets, devices }
 *   Route GET /api/cameras/discover?command_id đọc từ agent_commands.result.
 */
export interface EnqueueDiscoverLanArgs {
  organizationId: string;
  agentId: string;
  mode: "quick" | "full";
  subnets: string[] | null;
}

export async function enqueueDiscoverLan(
  args: EnqueueDiscoverLanArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "discover_lan",
      payload: {
        mode: args.mode,
        subnets: args.subnets,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue discover_lan failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

/**
 * 3c: enqueue job upload_clip. Agent đọc clip từ ổ local, xin
 * signed URL, PUT lên bucket, báo complete.
 */
export async function enqueueUploadClip(
  args: EnqueueUploadClipArgs,
): Promise<{ command_id: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "upload_clip",
      payload: {
        packing_event_id: args.packingEventId,
        bucket_path: args.bucketPath,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue upload_clip failed: ${error?.message}`);
  }
  return { command_id: data.id };
}

export async function enqueueCutClip(
  args: EnqueueCutClipArgs,
): Promise<EnqueueCutClipResult | EnqueueCutClipFailure> {
  const admin = createAdminClient();

  const { data: pe, error: peErr } = await admin
    .from("packing_events")
    .select(
      "id, organization_id, warehouse_id, station_id, staff_id, work_session_id, scanned_at, proof_camera_id, waybill_code, work_started_at, work_ended_at, work_duration_seconds, timing_status",
    )
    .eq("id", args.packingEventId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (peErr || !pe) {
    return { ok: false, reason: "not_found", message: peErr?.message ?? "packing_event not found" };
  }

  const resolved = await resolveClipBounds({
    organizationId: args.organizationId,
    packingEvent: {
      id: pe.id,
      warehouse_id: pe.warehouse_id,
      station_id: pe.station_id,
      staff_id: pe.staff_id,
      work_session_id: pe.work_session_id,
      scanned_at: pe.scanned_at,
      proof_camera_id: pe.proof_camera_id,
      work_ended_at: pe.work_ended_at,
      work_duration_seconds: pe.work_duration_seconds,
      timing_status: pe.timing_status,
    },
  });

  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason ?? "internal",
      message: resolved.message ?? "resolve failed",
    };
  }

  const segments = resolved.files ?? [];
  if (segments.length === 0 || !resolved.cameraId) {
    return {
      ok: false,
      reason: "no_segments",
      message: "no segments available for clip window",
    };
  }

  // Phát hiện gap giữa các segment liên tiếp. Feed
  // `order_proof_clips.is_partial` + `covered_range` + `total_gap_seconds`
  // → panel dashboard hiện "clip thiếu N giây".
  //
  // covered_range = [min(started_at), max(ended_at)] của tập segments.
  // Khoảng cách target_start → covered_range.lower là khoảng KHÔNG có
  // video ở đầu (nếu target_start rơi vào gap). Tương tự cuối.
  const gaps: Array<{
    from_iso: string;
    to_iso: string;
    gap_seconds: number;
  }> = [];
  let totalGapMs = 0;
  const sortedSegments = [...segments].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );
  for (let i = 0; i < sortedSegments.length - 1; i++) {
    const cur = sortedSegments[i];
    const next = sortedSegments[i + 1];
    if (!cur.ended_at) continue; // still-open đã bị loại ở resolver
    const curEndMs = new Date(cur.ended_at).getTime();
    const nextStartMs = new Date(next.started_at).getTime();
    const diff = nextStartMs - curEndMs;
    if (diff > GAP_DETECT_THRESHOLD_MS) {
      totalGapMs += diff;
      gaps.push({
        from_iso: cur.ended_at,
        to_iso: next.started_at,
        gap_seconds: Math.round(diff / 1000),
      });
    }
  }

  // Kiểm tra target có rơi vào gap ở đầu hoặc cuối không.
  const targetStartMs = resolved.clipStart.getTime();
  const targetEndMs = resolved.clipEnd.getTime();
  const firstSegStartMs = new Date(sortedSegments[0].started_at).getTime();
  const lastSeg = sortedSegments[sortedSegments.length - 1];
  const lastSegEndMs = lastSeg.ended_at ? new Date(lastSeg.ended_at).getTime() : targetEndMs;

  const missedHeadMs = Math.max(0, firstSegStartMs - targetStartMs);
  const missedTailMs = Math.max(0, targetEndMs - lastSegEndMs);
  if (missedHeadMs > 0) totalGapMs += missedHeadMs;
  if (missedTailMs > 0) totalGapMs += missedTailMs;

  const isPartial = gaps.length > 0 || missedHeadMs > 0 || missedTailMs > 0;

  // covered_range = khoảng [max(target_start, firstSeg.started_at),
  // min(target_end, lastSeg.ended_at)]. Là khoảng "có video" thực tế,
  // tuy có thể có gap nội bộ.
  const coveredStartMs = Math.max(targetStartMs, firstSegStartMs);
  const coveredEndMs = Math.min(targetEndMs, lastSegEndMs);

  // cut_start/cut_end đã bao gồm GOP pad. Không pad vào covered_range
  // — đó là "khoảng target sau khi tính pre/post-roll", không phải
  // "khoảng cắt kỹ thuật".
  const cutStartMs = targetStartMs - GOP_PAD_BEFORE_SECONDS * 1000;
  const cutEndMs = targetEndMs + GOP_PAD_AFTER_SECONDS * 1000;

  // work_started_at/work_ended_at đã BỎ khỏi payload 2026-07-05: agent
  // không dùng (video thuần, không burn/overlay). Panel dashboard join
  // packing_events lấy trực tiếp — nguồn chân lý ở DB, không cần copy
  // qua agent_commands.

  // Safe-retry H4: pre-insert row pending + enqueue agent_command trong
  // 1 transaction qua RPC atomic. Loại race "command đã insert nhưng
  // response mạng mất → xóa pending → command mồ côi trỏ clip_id đã bị xóa".
  //
  // Payload command KHÔNG chứa clip_id ở đây — RPC tự merge sau khi tạo
  // clip_id, đảm bảo consistency.
  const commandPayloadWithoutClipId = {
    replaces_clip_id: args.replacesClipId ?? null,
    packing_event_id: pe.id,
    camera_id: resolved.cameraId,
    waybill_code: pe.waybill_code,
    target_start: resolved.clipStart.toISOString(),
    target_end: resolved.clipEnd.toISOString(),
    cut_start: new Date(cutStartMs).toISOString(),
    cut_end: new Date(cutEndMs).toISOString(),
    segments: sortedSegments.map((s: SegmentFile) => ({
      file_path: s.file_path,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_seconds: s.duration_seconds,
    })),
    partial_coverage: isPartial,
    covered_range: {
      lower: new Date(coveredStartMs).toISOString(),
      upper: new Date(coveredEndMs).toISOString(),
    },
    gaps,
    total_gap_seconds: Math.round(totalGapMs / 1000),
    audit: {
      end_reason: resolved.endReason,
      next_scan_boundary: resolved.nextScan?.boundary ?? null,
      next_scan_scanned_at: resolved.nextScan?.scanned_at ?? null,
      session_end_ended_at: resolved.sessionEnd?.ended_at ?? null,
      pre_seconds: resolved.preSeconds,
      before_next_seconds: resolved.beforeNextSeconds,
      default_post_seconds: resolved.defaultPostSeconds,
      replaces_clip_id: args.replacesClipId ?? null,
    },
  };

  const generationParams = {
    end_reason: resolved.endReason,
    next_scan_boundary: resolved.nextScan?.boundary ?? null,
    next_scan_scanned_at: resolved.nextScan?.scanned_at ?? null,
    session_end_ended_at: resolved.sessionEnd?.ended_at ?? null,
    pre_seconds: resolved.preSeconds,
    before_next_seconds: resolved.beforeNextSeconds,
    default_post_seconds: resolved.defaultPostSeconds,
    replaces_clip_id: args.replacesClipId ?? null,
  };

  const { data: rpcRow, error: rpcErr } = await admin
    .rpc("enqueue_clip_generation", {
      p_organization_id: args.organizationId,
      p_packing_event_id: pe.id,
      p_camera_id: resolved.cameraId,
      p_waybill_code: pe.waybill_code,
      p_agent_id: args.agentId,
      p_clip_started_at: resolved.clipStart.toISOString(),
      p_clip_ended_at: resolved.clipEnd.toISOString(),
      p_is_partial: isPartial,
      p_source_files: sortedSegments.map((s) => ({
        file_path: s.file_path,
        started_at: s.started_at,
        ended_at: s.ended_at,
      })),
      p_generation_params: generationParams,
      p_command_payload: commandPayloadWithoutClipId,
    })
    .single<{ clip_id: string; command_id: string; result_status: string }>();

  if (rpcErr || !rpcRow) {
    throw new Error(`enqueue_clip_generation RPC failed: ${rpcErr?.message}`);
  }

  return {
    ok: true,
    command_id: rpcRow.command_id,
    clip_id: rpcRow.clip_id,
    is_partial: isPartial,
    segment_count: sortedSegments.length,
  };
}
