@AGENTS.md

## Quy ước tổ chức tài liệu

- Các tài liệu Markdown thuộc kế hoạch phải được đặt dưới `plans/` theo ba nhóm:
  - `plans/active/`: kế hoạch đang thực hiện.
  - `plans/completed/`: kế hoạch đã hoàn tất.
  - `plans/reports/`: báo cáo, tài liệu tham khảo và tổng hợp.
- Giữ `AGENTS.md`, `CLAUDE.md` và `change.md` ở thư mục gốc vì đây là các file điều khiển quy trình.
- Khi tạo hoặc di chuyển tài liệu, cập nhật `change.md` và không sử dụng lệnh Git.

## Quy ước credential camera

- URL RTSP, username, password và cổng test do người dùng cung cấp chỉ được dùng tạm thời trong bộ nhớ tiến trình kiểm thử; không ghi vào `.env`, mã nguồn, plan, report hoặc `change.md`.
- Luồng production phải giữ cơ chế hiện hữu: admin nhập username/password qua UI, Cloud lưu mật khẩu đã mã hoá và Agent chỉ nhận credential trong RAM khi xử lý lệnh.
