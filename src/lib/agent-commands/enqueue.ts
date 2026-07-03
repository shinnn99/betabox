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
const GAP_DETECT_THRESHOLD_MS = 500;

/**
 * Chống nghi cắt ghép (gap pháp lý) — 2 tầng đánh dấu:
 *
 * TẦNG 1: định vị điểm gap (gap 30-60s)
 *   Chèn dấu ngắn (mặc định 2s) tại đúng điểm nối — 2 frame đen +
 *   text "GAP <N> GIÂY / <M> PHÚT". Định vị đúng chỗ, không phá nhịp
 *   clip. Chống ca "clip nói có gap nhưng không chỉ chỗ nào".
 *
 * TẦNG 2: màn đen full (gap ≥60s)
 *   Chèn màn đen ĐÚNG độ dài gap. Phản ánh đúng "camera mất bao lâu".
 *
 * Gap <30s: chỉ burn-in warning chung ("[!] VIDEO CÓ KHOẢNG TRỐNG (N PHÚT)"),
 * không đánh dấu điểm — hiccup mạng ngắn coi là kỹ thuật vô hại.
 *
 * Ngưỡng chọn 2026-07-03 sau khi Hạnh cân UX-vs-pháp-lý:
 *   30s: đủ tráo gói cực nhẹ, camera LAN có thể hiccup 15-30s nên
 *        không lấy ngưỡng thấp hơn (tránh clip nhiều dấu vụn).
 *   60s: hành vi tráo có ý định cần ≥1 phút → màn đen full bắt buộc.
 *   2s dấu: đủ đọc text (50-60 frame), không dài như màn đen full.
 *
 * Config được qua env cho phép chỉnh theo tranh chấp thật.
 */
const MIN_GAP_TO_MARK_SECONDS = Number(
  process.env.MIN_GAP_TO_MARK_SECONDS ?? 30,
);
const MIN_GAP_TO_BLACK_FULL_SECONDS = Number(
  process.env.MIN_GAP_TO_BLACK_FULL_SECONDS ?? 60,
);
const MARK_DURATION_SECONDS = Number(
  process.env.MARK_DURATION_SECONDS ?? 2,
);

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
 * BLOCKS-GO-LIVE: producer CHƯA lọc theo độ lớn gap. Nếu resolve
 * ra khoảng phủ vắt qua gap lớn (VD 14 phút cam offline), enqueue
 * vẫn cho phép cắt clip partial — clip sinh ra nối thẳng qua gap,
 * trông liền mạch nhưng bỏ mất 14 phút. Rủi ro pháp lý (xem cọc
 * chi tiết trong warehouse-agent/src/clip-cutter.ts).
 *
 * Trước go-live: hoặc thêm ngưỡng ở đây (từ chối cắt khi tổng
 * gap > X), hoặc chuyển sang chèn dấu gap lên hình (3b), hoặc
 * cảnh báo cứng phía UI dựa trên is_partial + covered_range.
 * 3a-2 CHỈ báo covered_range đầy đủ để lát sau quyết được.
 */
export interface EnqueueCutClipArgs {
  organizationId: string;
  agentId: string;
  packingEventId: string;
  /**
   * Cọc #8 project_camera_probe_tech_debt_cocs — force_recut.
   *
   * User bấm [Thử lại] → retry endpoint xóa row+bucket+command cũ VÀ
   * enqueue command mới với force_recut=true. Agent nhận flag này →
   * xóa file `_clips/{pe_id}.mp4` cũ TRƯỚC khi check idempotent.
   *
   * Vì sao cần: file cũ có thể SAI (cắt theo window cũ sau khi
   * resolver fix, hoặc cắt lỗi trước đó). Nếu không force, agent thấy
   * file cũ có → skip idempotent với data file cũ → retry vô tác dụng.
   *
   * Auto-poll enqueue (không phải retry) giữ nguyên default (undefined
   * = false), idempotent tái sử dụng file cũ hợp lệ. Chỉ [Thử lại]
   * mới force.
   */
  forceRecut?: boolean;
}

export interface EnqueueCutClipResult {
  ok: true;
  command_id: string;
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
      "id, organization_id, warehouse_id, station_id, staff_id, work_session_id, scanned_at, proof_camera_id, waybill_code, work_started_at, work_ended_at",
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

  // Phát hiện gap giữa các segment liên tiếp. Nếu có gap nội bộ →
  // clip sẽ partial, nối thẳng qua gap (rủi ro pháp lý — xem cọc
  // BLOCKS-GO-LIVE ở đầu file này và trong clip-cutter.ts).
  //
  // covered_range = [min(started_at), max(ended_at)] của tập segments.
  // Khoảng cách target_start → covered_range.lower là khoảng KHÔNG có
  // video ở đầu (nếu target_start rơi vào gap). Tương tự cuối.
  const gaps: Array<{
    from_iso: string;
    to_iso: string;
    gap_seconds: number;
    after_segment_index: number;
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
        // Chèn dấu SAU segment index này. Agent dùng để đan xen concat
        // list: [seg0, mark_after_0, seg1, seg2, mark_after_2, seg3].
        after_segment_index: i,
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

  // work_started_at / work_ended_at là MỐC NGHIỆP VỤ GỐC từ
  // packing_events — cái này sẽ được BURN lên clip (3b-1) để khớp
  // log tuyệt đối. KHÁC với target_start/target_end (đã cộng pre-roll
  // 10s) và cut_start/cut_end (đã cộng thêm GOP pad 3s).
  //
  // Nếu work_started_at null (đơn không valid, không có timing
  // window mở) → fallback scanned_at, vì RPC process_waybill_scan
  // set work_started_at = scanned_at khi status='valid'. Với trường
  // hợp valid → work_started_at ≡ scanned_at, fallback không đổi
  // giá trị. Với trường hợp không valid → dùng scanned_at là mốc
  // gần nhất có ý nghĩa.
  //
  // work_ended_at có thể null (đơn chưa được đóng bởi scan kế) — agent
  // burn "(đang xử lý)" thay vì mốc.
  const workStartedIso = (pe.work_started_at ?? pe.scanned_at) as string;
  const workEndedIso = (pe.work_ended_at ?? null) as string | null;

  // Tính marks[] — chỉ những gap ≥ ngưỡng dấu. Mỗi mark là "chèn gì
  // vào đâu": kind (mark_short/black_full), duration_seconds, và
  // after_segment_index (agent biết chèn sau segment nào trong concat).
  //
  // KHÔNG chèn mark cho gap head/tail (missedHead/missedTail) — đó là
  // window rơi vào ngoài coverage segment, agent sẽ trim cutStart/cutEnd
  // theo segments thật (không có gì để chèn giữa). Chỉ mark gap NỘI BỘ
  // giữa hai segment (chống nghi cắt ghép giấu diếm giữa clip).
  interface GapMark {
    after_segment_index: number;
    gap_seconds: number;
    kind: "mark_short" | "black_full";
    duration_seconds: number;
  }
  const marks: GapMark[] = gaps
    .filter((g) => g.gap_seconds >= MIN_GAP_TO_MARK_SECONDS)
    .map((g) => {
      const isFull = g.gap_seconds >= MIN_GAP_TO_BLACK_FULL_SECONDS;
      return {
        after_segment_index: g.after_segment_index,
        gap_seconds: g.gap_seconds,
        kind: isFull ? "black_full" : "mark_short",
        duration_seconds: isFull ? g.gap_seconds : MARK_DURATION_SECONDS,
      };
    });

  const payload = {
    packing_event_id: pe.id,
    camera_id: resolved.cameraId,
    waybill_code: pe.waybill_code,
    target_start: resolved.clipStart.toISOString(),
    target_end: resolved.clipEnd.toISOString(),
    work_started_at: workStartedIso,
    work_ended_at: workEndedIso,
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
    // Chống nghi cắt ghép (2 tầng): dấu 2s tại gap 30-60s (định vị) +
    // màn đen full-length ở gap ≥60s (phản ánh độ dài). Agent version
    // cũ không đọc marks[] → cắt như cũ, không lỗi. Config MIN_GAP_*
    // ở env, mặc định 30s/60s/2s.
    marks,
    // Cọc #8 force_recut: agent xóa `_clips/{pe_id}.mp4` cũ trước khi
    // check idempotent. Chỉ set khi user bấm [Thử lại] — auto-poll
    // enqueue để undefined = idempotent tái sử dụng file cũ hợp lệ.
    force_recut: args.forceRecut === true ? true : undefined,
  };

  const { data, error } = await admin
    .from("agent_commands")
    .insert({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      type: "cut_clip",
      payload,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueue cut_clip failed: ${error?.message}`);
  }
  return {
    ok: true,
    command_id: data.id,
    is_partial: isPartial,
    segment_count: sortedSegments.length,
  };
}
