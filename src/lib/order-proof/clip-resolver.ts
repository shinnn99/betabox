import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Resolves the clip window for one packing_event ("scan A") according
// to warehouse business rules:
//
//   clip_start = scan_A.scanned_at - video_pre_seconds
//   clip_end   = next_scan.scanned_at - video_before_next_seconds
//
// where "next_scan" is the FIRST scan after A within the same boundary
// (work_session > station > staff, picked in that priority). Only the
// strongest available context is used — we never reach across stations
// or sessions to find a next scan, because that would mark the clip as
// "ended when somebody else scanned somewhere else", which is wrong.
//
// Fallbacks (in order of preference):
//   * No next_scan in scope -> clip_end = scanned_at + default_post.
//   * next_scan exists but next - before_next <= scanned_at -> same fallback,
//     with end_reason flagged so audit can see we rejected the next scan.

export type EndReason =
  | "next_scan"
  | "session_end"
  | "default_post"
  | "default_post_invalid_next_scan"
  | "default_post_invalid_session_end";

export interface ResolveResult {
  ok: boolean;
  reason?: "no_camera" | "no_segments" | "segment_still_open" | "internal";
  message?: string;
  cameraId?: string;
  clipStart: Date;
  clipEnd: Date;
  preSeconds: number;
  beforeNextSeconds: number;
  defaultPostSeconds: number;
  endReason: EndReason;
  nextScan?: NextScanInfo | null;
  sessionEnd?: SessionEndInfo | null;
  files?: SegmentFile[];
}

export interface SegmentFile {
  id: string;
  file_path: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface NextScanInfo {
  id: string;
  scanned_at: string;
  // Which boundary was used to qualify this next_scan.
  boundary: "work_session" | "station" | "staff";
}

// When there's no next valid scan but the operator's shift ended, we use
// the session end as the closing boundary instead of falling back to
// default_post. This matches how `packing_events.work_duration_seconds`
// is computed by the DB trigger, so the clip duration the operator sees
// agrees with the "T/g đóng đơn" column.
export interface SessionEndInfo {
  session_id: string;
  ended_at: string;
}

const FALLBACK_PRE = 10;
const FALLBACK_BEFORE_NEXT = 2;
const FALLBACK_DEFAULT_POST = 60;

// Hard ceilings to defend against a typo / wrong unit in
// warehouses.packing_timing_config (e.g. someone enters minutes instead
// of seconds and we end up cutting an hour-long clip). The numbers are
// intentionally generous — they exist to catch obvious misconfiguration,
// not to enforce a business policy.
const MAX_PRE = 120; // 2 minutes
const MAX_BEFORE_NEXT = 60; // 1 minute
const MAX_DEFAULT_POST = 600; // 10 minutes

interface TimingTriple {
  pre: number;
  beforeNext: number;
  defaultPost: number;
}

function readTimingConfig(cfg: unknown): TimingTriple {
  const out: TimingTriple = {
    pre: FALLBACK_PRE,
    beforeNext: FALLBACK_BEFORE_NEXT,
    defaultPost: FALLBACK_DEFAULT_POST,
  };
  if (!cfg || typeof cfg !== "object") return out;
  const c = cfg as Record<string, unknown>;
  const pre = Number(c.video_pre_seconds);
  const beforeNext = Number(c.video_before_next_seconds);
  const post = Number(c.video_default_post_seconds);
  // Clamp + log when a config value was over the safety ceiling. Silent
  // clamping makes "why is my 30-minute window only 10 minutes?" hard to
  // debug — the warn line is the breadcrumb that points at the wrong
  // packing_timing_config row.
  if (Number.isFinite(pre) && pre >= 0) {
    if (pre > MAX_PRE) {
      console.warn(
        `[clip-resolver] packing_timing_config.video_pre_seconds=${pre} ` +
          `exceeds MAX_PRE=${MAX_PRE}s — clamping. Check the warehouse config.`,
      );
    }
    out.pre = Math.min(pre, MAX_PRE);
  }
  // before_next can legitimately be 0 (cut exactly to the next scan).
  if (Number.isFinite(beforeNext) && beforeNext >= 0) {
    if (beforeNext > MAX_BEFORE_NEXT) {
      console.warn(
        `[clip-resolver] packing_timing_config.video_before_next_seconds=${beforeNext} ` +
          `exceeds MAX_BEFORE_NEXT=${MAX_BEFORE_NEXT}s — clamping. Check the warehouse config.`,
      );
    }
    out.beforeNext = Math.min(beforeNext, MAX_BEFORE_NEXT);
  }
  if (Number.isFinite(post) && post > 0) {
    if (post > MAX_DEFAULT_POST) {
      console.warn(
        `[clip-resolver] packing_timing_config.video_default_post_seconds=${post} ` +
          `exceeds MAX_DEFAULT_POST=${MAX_DEFAULT_POST}s — clamping. Check the warehouse config.`,
      );
    }
    out.defaultPost = Math.min(post, MAX_DEFAULT_POST);
  }
  return out;
}

interface PackingEventInput {
  id: string;
  warehouse_id: string | null;
  station_id: string | null;
  staff_id?: string | null;
  work_session_id?: string | null;
  scanned_at: string;
  proof_camera_id: string | null;
}

// Find the first scan after `current` that should mark the end of the
// current packing window. Boundary priority (strongest first):
//   1. work_session_id (best — same shift on the same station).
//   2. station_id (someone else took over the station mid-shift; their
//      first scan is still a reasonable "end of previous order" marker).
//   3. staff_id (operator carried a portable scanner across stations —
//      rare, but still a defensible boundary).
// If none of those are available, we don't reach further: a scan from
// an unrelated station/session must NOT close this order's clip.
async function findNextScanWithinBoundary(opts: {
  organizationId: string;
  current: PackingEventInput;
}): Promise<NextScanInfo | null> {
  const admin = createAdminClient();
  const { current } = opts;
  // Only valid scans should close a window. Duplicated / invalid /
  // unmapped scans aren't real "next orders".
  const VALID_STATUS = "valid";

  const baseSelect = "id, scanned_at";

  const orderAndLimit = (q: ReturnType<typeof admin.from> extends infer X ? X : never) => q; // typing helper; we apply order/limit below

  if (current.work_session_id) {
    const { data } = await admin
      .from("packing_events")
      .select(baseSelect)
      .eq("organization_id", opts.organizationId)
      .eq("work_session_id", current.work_session_id)
      .eq("status", VALID_STATUS)
      .gt("scanned_at", current.scanned_at)
      .order("scanned_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        id: data.id as string,
        scanned_at: data.scanned_at as string,
        boundary: "work_session",
      };
    }
  }

  if (current.station_id) {
    const { data } = await admin
      .from("packing_events")
      .select(baseSelect)
      .eq("organization_id", opts.organizationId)
      .eq("station_id", current.station_id)
      .eq("status", VALID_STATUS)
      .gt("scanned_at", current.scanned_at)
      .order("scanned_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        id: data.id as string,
        scanned_at: data.scanned_at as string,
        boundary: "station",
      };
    }
  }

  if (current.staff_id) {
    const { data } = await admin
      .from("packing_events")
      .select(baseSelect)
      .eq("organization_id", opts.organizationId)
      .eq("staff_id", current.staff_id)
      .eq("status", VALID_STATUS)
      .gt("scanned_at", current.scanned_at)
      .order("scanned_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        id: data.id as string,
        scanned_at: data.scanned_at as string,
        boundary: "staff",
      };
    }
  }

  return null;
  // (orderAndLimit kept to avoid an "unused" lint if we expand later)
  void orderAndLimit;
}

// When no next valid scan exists, the operator's session checkout is the
// canonical "I'm done with this order" marker — the DB trigger that
// computes work_duration_seconds uses the same fallback, so honouring it
// here keeps the clip and the column in sync.
//
// We accept either a closed session (status='ended' with ended_at set)
// or a session still open but whose ended_at has been written (rare).
// A session without ended_at can't be used.
async function findSessionEndForEvent(opts: {
  organizationId: string;
  current: PackingEventInput;
}): Promise<SessionEndInfo | null> {
  if (!opts.current.work_session_id) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("staff_work_sessions")
    .select("id, ended_at")
    .eq("organization_id", opts.organizationId)
    .eq("id", opts.current.work_session_id)
    .maybeSingle();
  if (!data || !data.ended_at) return null;
  return {
    session_id: data.id as string,
    ended_at: data.ended_at as string,
  };
}

export async function resolveClipBounds(opts: {
  organizationId: string;
  packingEvent: PackingEventInput;
  // Optional hook fired after camera + clipStart/clipEnd are decided
  // but BEFORE we query camera_recording_files for overlap. The proof
  // pipeline uses this to sync the camera's segment rows scoped to the
  // clip window, so users never have to press a "sync" button to get a
  // freshly-closed segment to show up.
  beforeFileQuery?: (info: {
    cameraId: string;
    clipStart: Date;
    clipEnd: Date;
  }) => Promise<void>;
}): Promise<ResolveResult> {
  const admin = createAdminClient();
  const { packingEvent } = opts;
  const scannedAt = new Date(packingEvent.scanned_at);

  // 1) Load timing config.
  let timing: TimingTriple = {
    pre: FALLBACK_PRE,
    beforeNext: FALLBACK_BEFORE_NEXT,
    defaultPost: FALLBACK_DEFAULT_POST,
  };
  if (packingEvent.warehouse_id) {
    const { data: wh } = await admin
      .from("warehouses")
      .select("packing_timing_config")
      .eq("id", packingEvent.warehouse_id)
      .maybeSingle();
    timing = readTimingConfig(wh?.packing_timing_config);
  }

  // 2) Find the closing boundary. Priority:
  //   a) Next VALID scan within the same work_session > station > staff.
  //   b) If none, the operator's session.ended_at (= shift checkout).
  //   c) If neither, fall back to default_post.
  // This mirrors how packing_events.work_duration_seconds is computed by
  // the DB trigger, so "T/g đóng đơn" agrees with the clip duration.
  const nextScan = await findNextScanWithinBoundary({
    organizationId: opts.organizationId,
    current: packingEvent,
  });
  const sessionEnd = nextScan
    ? null
    : await findSessionEndForEvent({
        organizationId: opts.organizationId,
        current: packingEvent,
      });

  // 3) Compute window.
  const clipStart = new Date(scannedAt.getTime() - timing.pre * 1000);
  let clipEnd: Date;
  let endReason: EndReason;
  if (nextScan) {
    const candidate = new Date(
      new Date(nextScan.scanned_at).getTime() - timing.beforeNext * 1000,
    );
    // Reject pathological next_scan where the resulting end would be at
    // or before the scan we're trying to clip — this can happen if two
    // valid scans land within `before_next_seconds` of each other.
    if (candidate.getTime() <= scannedAt.getTime()) {
      clipEnd = new Date(scannedAt.getTime() + timing.defaultPost * 1000);
      endReason = "default_post_invalid_next_scan";
    } else {
      clipEnd = candidate;
      endReason = "next_scan";
    }
  } else if (sessionEnd) {
    const candidate = new Date(sessionEnd.ended_at);
    // A session that ended before this scan (clock skew or a stale
    // row) must not close the clip; fall back to default_post.
    if (candidate.getTime() <= scannedAt.getTime()) {
      clipEnd = new Date(scannedAt.getTime() + timing.defaultPost * 1000);
      endReason = "default_post_invalid_session_end";
    } else {
      clipEnd = candidate;
      endReason = "session_end";
    }
  } else {
    clipEnd = new Date(scannedAt.getTime() + timing.defaultPost * 1000);
    endReason = "default_post";
  }

  // 4) Resolve camera (snapshot first, fallback resolver for legacy).
  let cameraId = packingEvent.proof_camera_id;
  if (!cameraId && packingEvent.station_id) {
    const { data } = await admin.rpc("resolve_station_camera_at", {
      p_organization_id: opts.organizationId,
      p_station_id: packingEvent.station_id,
      p_at: packingEvent.scanned_at,
    });
    if (typeof data === "string") cameraId = data;
  }
  if (!cameraId) {
    return {
      ok: false,
      reason: "no_camera",
      message:
        "Không xác định được camera lúc quét. Camera có thể chưa gắn vào bàn ở thời điểm đó.",
      clipStart,
      clipEnd,
      preSeconds: timing.pre,
      beforeNextSeconds: timing.beforeNext,
      defaultPostSeconds: timing.defaultPost,
      endReason,
      nextScan,
      sessionEnd,
    };
  }

  // 5) Optional pre-query hook (e.g. sync segment files from disk so the
  // DB has up-to-date rows for the window we're about to query).
  if (opts.beforeFileQuery) {
    try {
      await opts.beforeFileQuery({ cameraId, clipStart, clipEnd });
    } catch (err) {
      // Don't fail the whole resolve just because a refresh hook
      // throws — fall back to whatever rows are already in the DB.
      console.error("[clip-resolver] beforeFileQuery hook failed:", err);
    }
  }

  // 6) Find overlapping segments. We filter at the SQL level on BOTH
  // edges of the window so the payload is bounded even on cameras with
  // months of history: started_at < clipEnd AND (ended_at IS NULL OR
  // ended_at > clipStart). The JS pass below is still needed to keep
  // the still-open check (an open segment whose started_at <= clipEnd
  // is what triggers "segment_still_open").
  //
  // PostgREST .or() uses comma as the term separator. ISO 8601 from
  // toISOString() contains ':' and '.' but no commas, so it's safe to
  // embed unquoted — we still wrap in "..." defensively in case Supabase
  // tightens parsing for timestamps in a future version.
  const clipStartIso = clipStart.toISOString();
  const clipEndIso = clipEnd.toISOString();
  const { data: files, error } = await admin
    .from("camera_recording_files")
    .select("id, file_path, started_at, ended_at, duration_seconds")
    .eq("organization_id", opts.organizationId)
    .eq("camera_id", cameraId)
    // Lát 3a-1 tách hai nguồn (agent/legacy_nextjs) — clip cắt bởi
    // 3a-2 CHỈ đọc row do agent ghi, không lẫn với row từ route
    // Next.js cũ (file trỏ ổ máy khác, có thể không tồn tại trên ổ
    // agent). Nếu bỏ filter này thì clip có thể lấy segment không
    // tồn tại và fail sớm, hoặc tệ hơn: lẫn nội dung sai đơn.
    .eq("source", "agent")
    .lt("started_at", clipEndIso)
    .or(`ended_at.is.null,ended_at.gt."${clipStartIso}"`)
    .order("started_at", { ascending: true });
  if (error) {
    return {
      ok: false,
      reason: "internal",
      message: error.message,
      clipStart,
      clipEnd,
      preSeconds: timing.pre,
      beforeNextSeconds: timing.beforeNext,
      defaultPostSeconds: timing.defaultPost,
      endReason,
      nextScan,
      sessionEnd,
      cameraId,
    };
  }
  const overlap = (files ?? []).filter((f) => {
    // Open file (ended_at NULL) is kept for the still-open check below.
    if (!f.ended_at) return true;
    return new Date(f.ended_at).getTime() > clipStart.getTime();
  }) as SegmentFile[];

  if (overlap.length === 0) {
    return {
      ok: false,
      reason: "no_segments",
      message:
        "Không có video tại khoảng thời gian đóng đơn. Camera có thể chưa ghi hình tại thời điểm này.",
      clipStart,
      clipEnd,
      preSeconds: timing.pre,
      beforeNextSeconds: timing.beforeNext,
      defaultPostSeconds: timing.defaultPost,
      endReason,
      nextScan,
      sessionEnd,
      cameraId,
    };
  }

  // 7) If any overlapping segment is still open AND its started_at <=
  // clipEnd, we don't yet have data flushed to cover the tail. Tell
  // the caller to retry — don't cut a corrupt clip.
  const hasOpenInRange = overlap.some(
    (f) =>
      f.ended_at === null &&
      new Date(f.started_at).getTime() <= clipEnd.getTime(),
  );
  if (hasOpenInRange) {
    return {
      ok: false,
      reason: "segment_still_open",
      message:
        "Video tại thời điểm quét chưa sẵn sàng, vui lòng thử lại sau khi segment hiện tại đóng.",
      clipStart,
      clipEnd,
      preSeconds: timing.pre,
      beforeNextSeconds: timing.beforeNext,
      defaultPostSeconds: timing.defaultPost,
      endReason,
      nextScan,
      sessionEnd,
      cameraId,
      files: overlap,
    };
  }

  // 8) Filter out any still-open segments (defense in depth — at this
  // point they shouldn't be needed since their started_at > clipEnd).
  const usableFiles = overlap.filter((f) => f.ended_at !== null);
  if (usableFiles.length === 0) {
    return {
      ok: false,
      reason: "no_segments",
      message:
        "Không có segment đã đóng nào trong khoảng cần cắt.",
      clipStart,
      clipEnd,
      preSeconds: timing.pre,
      beforeNextSeconds: timing.beforeNext,
      defaultPostSeconds: timing.defaultPost,
      endReason,
      nextScan,
      sessionEnd,
      cameraId,
    };
  }

  return {
    ok: true,
    cameraId,
    clipStart,
    clipEnd,
    preSeconds: timing.pre,
    beforeNextSeconds: timing.beforeNext,
    defaultPostSeconds: timing.defaultPost,
    endReason,
    nextScan,
    files: usableFiles,
  };
}
