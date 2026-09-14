-- B.2: camera QR scans use an explicit raw-event source while preserving all
-- existing source values. packing_stations.scan_source remains scanner|camera.
ALTER TABLE public.warehouse_scan_raw_events
  DROP CONSTRAINT IF EXISTS warehouse_scan_raw_events_source_check;

ALTER TABLE public.warehouse_scan_raw_events
  ADD CONSTRAINT warehouse_scan_raw_events_source_check
  CHECK (source IN ('serial', 'hid_keyboard', 'manual', 'camera_qr'));

COMMENT ON COLUMN public.warehouse_scan_raw_events.source IS
  'Physical scan origin. camera_qr is emitted by the QR camera service.';
