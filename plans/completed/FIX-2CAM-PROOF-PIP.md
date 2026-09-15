# FIX-2CAM-PROOF-PIP — Clip bằng chứng hai camera

## Kết quả

- Sửa nguyên nhân clip chỉ có Hikvision: payload proof nay chứa segment riêng của góc toàn cảnh và góc QR, lọc theo đúng agent giữ file.
- Agent ghép cùng bố cục live tại bàn: Hikvision toàn khung 1920×1080, Dahua 640×360 ở góc trên phải có viền trắng, dải thông tin ở đáy, H.264 và không âm thanh.
- File MP4 cuối có hard cap 180 giây tính cả pre-roll. Môi trường QA dùng guard 150 MiB.
- Segment report ghi `agent_id` từ agent đã xác thực HMAC.

## Kiểm thử thật

- Clip `SPXVN063348086638`: 132,72 giây, 51.444.746 byte, H.264 1920×1080.
- Đã kiểm tra ảnh khung hình: đủ Hikvision và Dahua, đúng vị trí PiP và dải đáy.
- Đã thay object QA trên Supabase; metadata xác nhận hai góc `overview` và `qr`.
- Root test: 337/337; agent test: 88/88; typecheck hai project và ESLint mục tiêu đều đạt.
