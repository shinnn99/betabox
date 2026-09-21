import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phiên ghi hoàn: khoảng thời gian mà đoạn video của bàn **thuộc về luồng
 * hàng hoàn**.
 *
 * Camera của bàn vẫn ghi liên tục cho luồng đóng hàng — không thể vừa ghi
 * liên tục cho đơn đi vừa không ghi cho cùng camera đó. Cái mà tín hiệu
 * module bật/tắt là quyền sở hữu: segment nào mang nhãn phiên hoàn. Chỉ
 * segment mang nhãn mới bị rút hạn lưu xuống 7 ngày.
 *
 * Không có tín hiệu tới agent → không nhãn → không rút hạn. Đó là chốt của
 * chủ dự án 21/09/2026: "không có thì không thực hiện".
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

export interface ReturnCaptureResult {
  captureId: string | null;
  cameraIds: string[];
  /** Phiên đã mở sẵn trước lượt này (người thứ hai vào cùng bàn). */
  alreadyOpen: boolean;
  /** Đã xếp được lệnh cho ít nhất một agent. false = chưa máy nào biết. */
  agentNotified: boolean;
}

/**
 * Xếp tín hiệu bật/tắt xuống agent.
 *
 * Gửi cho MỌI agent đang hoạt động của tổ chức chứ không đoán máy nào giữ
 * camera nào: agent chỉ gán nhãn cho camera nó đang ghi, nên máy không liên
 * quan nhận lệnh cũng không làm gì. Đoán sai máy thì mất nhãn, mà mất nhãn
 * thì không ai biết cho tới lúc cần video.
 */
async function signalAgents(params: {
  admin: SupabaseClient;
  organizationId: string;
  captureId: string;
  stationId: string;
  cameraIds: string[];
  active: boolean;
}): Promise<boolean> {
  const { data: agents, error } = await params.admin
    .from("warehouse_agents")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("status", "active");
  if (error || !agents || agents.length === 0) {
    if (error) {
      console.warn(`[return-capture] không đọc được danh sách agent: ${error.message}`);
    }
    return false;
  }

  const rows = agents.map((a) => ({
    organization_id: params.organizationId,
    agent_id: (a as { id: string }).id,
    type: "set_return_capture",
    payload: {
      capture_id: params.captureId,
      station_id: params.stationId,
      camera_ids: params.cameraIds,
      active: params.active,
    },
  }));

  const { error: insertErr } = await params.admin.from("agent_commands").insert(rows);
  if (insertErr) {
    console.warn(`[return-capture] không xếp được lệnh: ${insertErr.message}`);
    return false;
  }
  return true;
}

/** Mở hoặc tham gia phiên ghi hoàn của một bàn. */
export async function openReturnCapture(params: {
  admin: SupabaseClient;
  organizationId: string;
  stationId: string;
  /** 'card' hoặc 'module:<user_id>'. */
  holder: string;
  at?: string;
}): Promise<ReturnCaptureResult> {
  const { data, error } = await params.admin.rpc("open_return_capture", {
    p_station_id: params.stationId,
    p_holder: params.holder,
    p_at: params.at ?? new Date().toISOString(),
  });
  if (error) throw new Error(`open_return_capture: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { capture_id: string; camera_ids: string[] | null; already_open: boolean }
    | undefined;
  if (!row?.capture_id) {
    return { captureId: null, cameraIds: [], alreadyOpen: false, agentNotified: false };
  }

  const cameraIds = row.camera_ids ?? [];
  // Gửi lại tín hiệu cả khi phiên đã mở sẵn: agent có thể vừa khởi động lại
  // và quên mất phiên. Lệnh idempotent theo capture_id nên gửi thừa vô hại.
  const agentNotified =
    cameraIds.length > 0 &&
    (await signalAgents({
      admin: params.admin,
      organizationId: params.organizationId,
      captureId: row.capture_id,
      stationId: params.stationId,
      cameraIds,
      active: true,
    }));

  return {
    captureId: row.capture_id,
    cameraIds,
    alreadyOpen: Boolean(row.already_open),
    agentNotified,
  };
}

/** Gia hạn nhịp của một người đang mở giao diện. */
export async function touchReturnCapture(params: {
  admin: SupabaseClient;
  stationId: string;
  holder: string;
  at?: string;
}): Promise<string | null> {
  const { data, error } = await params.admin.rpc("touch_return_capture", {
    p_station_id: params.stationId,
    p_holder: params.holder,
    p_at: params.at ?? new Date().toISOString(),
  });
  if (error) throw new Error(`touch_return_capture: ${error.message}`);
  return (data as string | null) ?? null;
}

export interface ReleaseResult {
  captureId: string | null;
  /** Còn nguồn khác đang giữ phiên (tab khác, hoặc thẻ QR). */
  stillHeld: boolean;
}

/**
 * Nhả một nguồn giữ phiên.
 *
 * Chỉ khi hết nguồn mới gửi tín hiệu TẮT. Agent nhận TẮT vẫn gán nốt đoạn
 * video đang ghi dở rồi mới báo xong — phần "chạy ngầm tới khi lưu xong"
 * nằm ở agent, không phụ thuộc trình duyệt còn mở hay không.
 */
export async function releaseReturnCapture(params: {
  admin: SupabaseClient;
  organizationId: string;
  stationId: string;
  holder: string;
  reason?: string;
  at?: string;
}): Promise<ReleaseResult> {
  const { data, error } = await params.admin.rpc("release_return_capture", {
    p_station_id: params.stationId,
    p_holder: params.holder,
    p_reason: params.reason ?? "module_exit",
    p_at: params.at ?? new Date().toISOString(),
  });
  if (error) throw new Error(`release_return_capture: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { capture_id: string | null; still_held: boolean; camera_ids: string[] | null }
    | undefined;
  if (!row?.capture_id) return { captureId: null, stillHeld: false };

  if (!row.still_held) {
    await signalAgents({
      admin: params.admin,
      organizationId: params.organizationId,
      captureId: row.capture_id,
      stationId: params.stationId,
      cameraIds: row.camera_ids ?? [],
      active: false,
    });
  }

  return { captureId: row.capture_id, stillHeld: Boolean(row.still_held) };
}

export type CaptureState = "none" | "active" | "draining" | "finished" | "abandoned";

export interface CaptureStatus {
  captureId: string;
  stationId: string;
  state: CaptureState;
  holders: string[];
  agentAcked: boolean;
  startedAt: string;
  endedAt: string | null;
  captureEndedAt: string | null;
}

/**
 * Trạng thái phiên gần nhất của một bàn — kể cả phiên đã đóng nhưng còn
 * đang rút, vì giao diện phải nói được "đang lưu nốt đoạn cuối".
 */
export async function readCaptureStatus(params: {
  admin: SupabaseClient;
  stationId: string;
}): Promise<CaptureStatus | null> {
  const { data, error } = await params.admin
    .from("station_mode_periods")
    .select(
      "id, station_id, capture_state, holders, agent_acked_at, started_at, ended_at, capture_ended_at",
    )
    .eq("station_id", params.stationId)
    .eq("mode", "return")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`readCaptureStatus: ${error.message}`);

  const row = data?.[0] as
    | {
        id: string;
        station_id: string;
        capture_state: CaptureState;
        holders: string[] | null;
        agent_acked_at: string | null;
        started_at: string;
        ended_at: string | null;
        capture_ended_at: string | null;
      }
    | undefined;
  if (!row) return null;

  return {
    captureId: row.id,
    stationId: row.station_id,
    state: row.capture_state,
    holders: row.holders ?? [],
    agentAcked: row.agent_acked_at !== null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    captureEndedAt: row.capture_ended_at,
  };
}

// ---------------------------------------------------------------------------
// Nhiều bàn song song (đợt 6)
// ---------------------------------------------------------------------------

/**
 * Người giữ phiên từ giao diện: `module:<user_id>:<tab_id>`.
 *
 * Theo TAB chứ không theo tài khoản: kho hay dùng chung một tài khoản cho
 * mọi máy ở bàn. Giữ theo tài khoản thì máy này thoát là tắt luôn phiên mà
 * máy khác đang giữ ở cùng bàn. `tab_id` do trình duyệt sinh ngẫu nhiên và
 * chỉ là phần đuôi — phần `user_id` luôn lấy từ phiên đăng nhập ở server,
 * nên không ai giả được người giữ phiên của người khác.
 *
 * Không có tab_id (giao diện cũ) thì về dạng `module:<user_id>` như đợt 5.
 */
const TAB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function moduleHolder(userId: string, tabId: unknown): string {
  return typeof tabId === "string" && TAB_ID_RE.test(tabId)
    ? `module:${userId}:${tabId}`
    : `module:${userId}`;
}

export interface StationCaptureStatus {
  stationId: string;
  state: CaptureState;
  holders: string[];
  agentAcked: boolean;
  /** Kỳ còn mở (chưa ai nhả hết). Phiên đang rút thì kỳ đã đóng. */
  open: boolean;
}

/**
 * Trạng thái phiên của MỌI bàn trong tổ chức bằng một truy vấn — trang
 * giám sát cần cả kho cùng lúc, hỏi từng bàn là N request mỗi lần tải.
 *
 * Mỗi bàn lấy kỳ NHẬN HOÀN mới nhất còn liên quan: đang mở, hoặc đang rút.
 * Bàn không có gì liên quan thì không có mặt trong kết quả (= chưa nhận hoàn).
 */
export async function readCaptureStatuses(params: {
  admin: SupabaseClient;
  organizationId: string;
}): Promise<Map<string, StationCaptureStatus>> {
  const { data, error } = await params.admin
    .from("station_mode_periods")
    .select("station_id, capture_state, holders, agent_acked_at, ended_at, started_at")
    .eq("organization_id", params.organizationId)
    .eq("mode", "return")
    .or("ended_at.is.null,capture_state.eq.draining")
    .order("started_at", { ascending: false });
  if (error) throw new Error(`readCaptureStatuses: ${error.message}`);

  const out = new Map<string, StationCaptureStatus>();
  for (const row of (data ?? []) as Array<{
    station_id: string;
    capture_state: CaptureState;
    holders: string[] | null;
    agent_acked_at: string | null;
    ended_at: string | null;
  }>) {
    // Đã có kỳ mới hơn của bàn này thì bỏ kỳ cũ.
    if (out.has(row.station_id)) continue;
    out.set(row.station_id, {
      stationId: row.station_id,
      state: row.capture_state,
      holders: row.ended_at === null ? (row.holders ?? []) : [],
      agentAcked: row.agent_acked_at !== null,
      open: row.ended_at === null,
    });
  }
  return out;
}
