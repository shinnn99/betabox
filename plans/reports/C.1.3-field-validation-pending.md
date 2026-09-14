# C.1.3 — Báo cáo phần nghiệm thu còn thiếu

Ngày 2026-09-14, phần triển khai và kiểm thử tự động đã đạt: typecheck agent/root, 86/86 test, decode QR thật từ grayscale frame, và đóng gói `.exe` với WASM local.

Tiêu chí chưa chạy được: replay video kho đã ghi trong 3 ngày và đối chiếu số lần phát với máy quét. Không tìm thấy file `.mp4`, `.mkv`, `.avi`, `.mov` hoặc `.ts` trong workspace/recording data hiện có.

Cần một trong hai đầu vào:

- đường dẫn tới tập video camera QR thực tế và log máy quét tương ứng; hoặc
- camera thử nghiệm đang nối vào máy agent để chạy nghiệm thu trực tiếp.

Không chuyển C.1.3 sang `plans/completed` và không bắt đầu C.1.4 trước khi chốt tiêu chí này, theo quy tắc hoàn thiện từng task.
