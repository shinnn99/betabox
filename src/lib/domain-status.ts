// Single source of truth for the status text values defined by CHECK
// constraints in Supabase. Any place in TypeScript that compares against a
// `status`/`action`/`timing_status` column must import from here so a typo
// fails compile instead of silently filtering to zero rows.
//
// Verified via `pg_get_functiondef` + information_schema.check_constraints
// on 2026-06-30. If you add a value here, update the matching CHECK
// constraint via a migration first, never the other way round.

export const PACKING_EVENT_STATUSES = [
  "valid",
  "duplicated",
  "no_active_session",
  "unmapped_scanner",
  "invalid_code",
] as const;
export type PackingEventStatus = (typeof PACKING_EVENT_STATUSES)[number];

export const PACKING_EVENT_TIMING_STATUSES = [
  "open",
  "finalized_by_next_scan",
  "finalized_by_checkout",
  "capped_timeout",
  "default_estimated",
  "not_applicable",
] as const;
export type PackingEventTimingStatus =
  (typeof PACKING_EVENT_TIMING_STATUSES)[number];

/**
 * Chỉ HAI trạng thái này cho ra `work_duration_seconds` là số ĐO ĐƯỢC.
 *
 *   capped_timeout    → duration bị ép = max_order_seconds (ngưỡng cấu
 *                       hình), không phải thời gian đóng gói thật.
 *   default_estimated → duration bị ép = default_last_order_seconds
 *                       (60s mặc định) vì ra ca quá muộn.
 *   open              → chưa có duration.
 *   not_applicable    → đơn không mở cửa sổ timing.
 *
 * Trộn số ép cứng vào KPI năng suất làm sai lệch cả hai chiều. Đo ở kho
 * Đại Kim 2026-08-07: trung bình gộp 95,3s vs trung bình đo được 68,2s,
 * trong khi gap thật trung bình là 260,2s. Không con số gộp nào dùng
 * được để đánh giá năng suất.
 */
export const PACKING_EVENT_MEASURED_TIMING_STATUSES: readonly PackingEventTimingStatus[] =
  ["finalized_by_next_scan", "finalized_by_checkout"];

/** true khi work_duration_seconds của event là số đo được, không phải số ép. */
export function isMeasuredDuration(
  timingStatus: string | null | undefined,
): boolean {
  return (
    timingStatus === "finalized_by_next_scan" ||
    timingStatus === "finalized_by_checkout"
  );
}

export const PACKING_EVENT_ASSIGNMENT_METHODS = [
  "active_session",
  "fallback_recent_session",
  "none",
] as const;
export type PackingEventAssignmentMethod =
  (typeof PACKING_EVENT_ASSIGNMENT_METHODS)[number];

export const CAMERA_RECORDING_SESSION_STATUSES = [
  "recording",
  "stopped",
  "error",
] as const;
export type CameraRecordingSessionStatus =
  (typeof CAMERA_RECORDING_SESSION_STATUSES)[number];

export const STAFF_WORK_SESSION_STATUSES = [
  "active",
  "ended",
  "forced_ended",
] as const;
export type StaffWorkSessionStatus =
  (typeof STAFF_WORK_SESSION_STATUSES)[number];

export const STAFF_QR_SCAN_RESULT_ACTIONS = [
  "checked_in",
  "checked_out",
  "switched_station",
  "replaced_staff",
  "ignored",
] as const;
export type StaffQrScanResultAction =
  (typeof STAFF_QR_SCAN_RESULT_ACTIONS)[number];

export const ORDER_PROOF_CLIP_STATUSES = [
  "pending",
  "ready",
  "failed",
  "superseded",
  // Thêm 2026-08-07 để khớp CHECK constraint đã có từ migration
  // 20260723173403_add_evicted_status_to_clips. File này drift 15 ngày —
  // 'evicted' đã được ghi vào DB (37 row) mà union TS chưa biết.
  "evicted",
] as const;
export type OrderProofClipStatus = (typeof ORDER_PROOF_CLIP_STATUSES)[number];

export const CAMERA_STATUSES = ["active", "inactive", "error"] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

export const STATION_DEVICE_STATUSES = ["active", "inactive", "archived"] as const;
export type StationDeviceStatus = (typeof STATION_DEVICE_STATUSES)[number];

export const STATION_DEVICE_CONNECTION_STATUSES = [
  "connected",
  "disconnected",
  "unknown",
  "error",
] as const;
export type StationDeviceConnectionStatus =
  (typeof STATION_DEVICE_CONNECTION_STATUSES)[number];

// Convenience: which packing_events.status values count as a "real" packing
// attempt that should appear on the operator dashboard. Mirrors the
// listScans default in order-proof/service.ts.
export const PACKING_EVENT_REAL_ATTEMPT_STATUSES: readonly PackingEventStatus[] = [
  "valid",
  "duplicated",
];

// packing_events.status values that the dashboard should surface as a
// problem the operator must triage. Everything outside `valid`/`duplicated`.
export const PACKING_EVENT_PROBLEM_STATUSES: readonly PackingEventStatus[] = [
  "no_active_session",
  "unmapped_scanner",
  "invalid_code",
];
