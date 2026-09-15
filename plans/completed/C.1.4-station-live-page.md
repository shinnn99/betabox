# C.1.4 — Trang live tại bàn

## Đã hoàn thành

- Trang `/dashboard/station` chỉ lấy bàn gán cho tài khoản đóng gói.
- API live kiểm tổ chức, vai trò và bàn được gán; chỉ trả WHEP path, không trả RTSP/credential.
- `LiveLayout` dùng chung: Hikvision toàn cảnh toàn khung, Dahua QR ở ô 1/9 góc trên phải, viền trắng mảnh và dải đáy.
- Trang Giám sát đóng hàng hiển thị Bàn 3 trong đúng tenant; bấm thẻ bàn để mở live, bấm lại để đóng viewer mà không dừng camera/recording.
- Nút toàn màn hình hoạt động hai chiều: bấm để phóng, bấm lại để thu; trạng thái tự đồng bộ khi thoát bằng phím Esc.
- Đăng nhập tài khoản `packer` điều hướng vào trang bàn.
- QR thực tế từ Dahua được giải mã sau khi bật khử nhiễu ZXing.
- Hai camera test đã dùng H.264: Hikvision `hik_3` làm `proof_primary`, Dahua `dahua_3` làm `proof_qr`; cùng gắn `AGENT_KHO_HN_01` và `BAN_03`.
- Sửa xung đột class `relative`/`absolute` làm ô Dahua PiP bị đẩy khỏi khung `overflow-hidden`.

## Kiểm tra

- `pnpm typecheck`: đạt.
- ESLint các file live/Operations: 0 lỗi; còn một warning polling có trước tại `operations/page.tsx:778`.
- Test helper live: 5/5 đạt.
- Test warehouse-agent: 88/88 đạt.
- MediaMTX: cả hai phiên WHEP được thiết lập; Hikvision H.264 2688×1520 và Dahua H.264 1920×1080.
- CORS WHEP localhost: đạt (`204`, đúng origin `http://localhost:3000`).
- Credential camera chỉ được giải mã trong RAM của relay QA; không ghi vào file cấu hình hay source.

**Trạng thái:** Đã hoàn thành
