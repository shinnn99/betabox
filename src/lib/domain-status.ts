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
