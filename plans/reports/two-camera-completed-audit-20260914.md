# Audit các plan 2 camera đã đánh dấu completed

Ngày audit: 2026-09-14

## Kết luận

`C.1-agent-mediamtx-qr.md` và `D.1-proof-queue-pip.md` chưa đạt tiêu chí hoàn thành trong `docs/tuan-tu-xu-ly-2-camera.md`. Cả hai đã được chuyển lại `plans/active/`.

## C.1 còn thiếu

- MediaMTX binary/license, supervisor restart, nối lifecycle vào `index.ts`, shutdown và installer.
- `shift-recording.ts` và đường ghi ngay tại chỗ khi mất mạng.
- QR frame source, decoder, scan service, command `test_qr_decode`, config và test bắt buộc.
- Station page, `LiveLayout`, notification UI, navigation và shortcut kiosk.
- Toàn bộ remote-live: VPS config/service, media auth, session API/UI, publisher và agent commands.

## D.1 còn thiếu

- Resolver/payload hai góc và lọc segment theo agent sở hữu.
- Queue state đúng thiết kế và trạng thái trên scans/videos UI.
- Compose plan thuần, encoder detection, font extraction, progress/lease 45 phút.
- Tích hợp composer vào nhánh `cut_clip`, kiểm tra lại QR, retry bitrate, thiếu-góc fallback.
- Download URL/route/UI và audit tải file.

## Mâu thuẫn cần quyết định

1. Nguồn scan: tài liệu dùng `camera_qr`; API hiện dùng `camera`.
2. Queue state: tài liệu dùng `waiting_agent/dispatched`; migration dùng `pending/processing/ready/failed`.
3. Video output: code cũ chốt không overlay; tài liệu chốt yêu cầu dải thông tin đáy.
4. `order_proof_requests` thiếu khóa duy nhất cho một yêu cầu đang chờ mỗi đơn và thiếu liên kết trực tiếp packing event/station/agent, khiến dispatch có thể chọn nhầm event.
5. B.2 chưa có API gán camera/virtual scanner nhưng là prerequisite của C.1.

## Trạng thái

Báo lỗi — dừng theo quy tắc dự án, chờ xác nhận lấy `docs/tuan-tu-xu-ly-2-camera.md` làm nguồn kiến trúc duy nhất và quay lại hoàn thiện prerequisite B.2 trước C.1.
