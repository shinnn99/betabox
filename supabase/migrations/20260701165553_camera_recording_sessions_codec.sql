-- Lát 3b-2 followup: HEVC detection.
--
-- Tách sự thật quan sát (`codec_detected`) khỏi diễn giải
-- (`codec_warning`):
--   codec_detected: giá trị codec THẬT ffprobe trả (h264, hevc,
--     mpeg4, ...). NULL khi probe fail/chưa probe. Đây là fact.
--   codec_warning: text mô tả VẤN ĐỀ (VD 'not_browser_safe' khi
--     codec ≠ h264). NULL khi codec ok hoặc probe fail. Đây là
--     diễn giải, có thể đổi quy tắc mà không mất fact.
--
-- Vì sao tách: nếu sau này thêm codec khác (av1?) hoặc đổi quy tắc
-- "cái nào browser-safe", chỉ đổi logic sinh codec_warning, không
-- mất codec_detected.
--
-- BLOCKS-GO-LIVE (nhắc, cắm cọc chi tiết trong recording.ts):
-- HEVC-not-blocked. Agent chỉ CẢNH BÁO khi phát hiện non-h264,
-- CHƯA từ chối cứng (mất data). Trước go-live, quyết cách xử (ép
-- H.264 tuyệt đối hay chấp nhận HEVC + transcode ở xem?) — 3c quyết.

alter table public.camera_recording_sessions
  add column codec_detected text,
  add column codec_warning text;
