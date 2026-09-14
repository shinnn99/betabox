# C.1.3 — Camera QR reader

Hoàn thiện frame source, ZXing decoder, zone state machine, scan service, queue `camera_qr`, command test và test bắt buộc.

**Trạng thái:** Đang xử lý

## Đã thực hiện

- Frame source FFmpeg từ MediaMTX localhost, fixed grayscale frame và drop frame khi decoder bận.
- ZXing WASM 3.1.4 local, state machine vùng quét, scan service, queue `camera_qr` và `test_qr_decode`.
- 86/86 test đạt; QR thật được decode; agent `.exe` build không còn cảnh báo thiếu module/WASM.

## Còn chờ nghiệm thu

Workspace chưa có video kho/segment để chạy replay 3 ngày và đối chiếu số đơn với máy quét theo tiêu chí kiến trúc. Giữ task ở `active` cho tới khi có đường dẫn video đầu vào hoặc camera thử nghiệm.
