# Cách cài Betacom Agent cho khách

Ngắn — dùng cho Hạnh/Hoàng khi giao kho khách.

## 1. Chuẩn bị trước khi đến kho

Tạo agent trên dashboard admin:
1. Vào https://betabox.vercel.app/dashboard (login owner).
2. Warehouses → chọn kho khách → Agents → **Tạo agent mới**.
3. Chép 2 giá trị:
   - `AGENT_CODE` — dạng `AGENT_KHO_XX_01`.
   - `AGENT_SECRET` — chuỗi hex dài. **Chỉ hiện 1 lần**, dán vào Notepad giữ lại.

## 2. Yêu cầu máy kho

- Windows 10/11 x64.
- Ổ đĩa lưu video ≥500GB (ổ D: hoặc E:, KHÔNG ổ C:).
- Camera IP RTSP đã cấu hình sẵn (ONVIF hoặc URL RTSP thẳng), test được bằng VLC.
- Máy quét mã vạch USB Virtual COM (KAW-K136 hoặc tương đương).

## 3. Cài đặt

1. Copy `BetacomAgentSetup-vX.Y.Z.exe` sang máy kho (USB hoặc download).
2. Click phải → **Run as administrator**.
3. Bấm Next → chọn thư mục cài (mặc định `C:\Program Files\BetacomAgent`, giữ nguyên).
4. Trang **Cấu hình Agent** — nhập 3 field:
   - `BACKEND_URL`: `https://betabox.vercel.app` (giữ mặc định)
   - `AGENT_CODE`: dán từ bước 1.
   - `AGENT_SECRET`: dán từ bước 1.
5. Trang **Thư mục lưu video** — chọn ổ lớn (mặc định `D:\beta_cam_recordings`).
6. Bấm Install → chờ 1-2 phút.

Installer tự làm 4 việc phía sau:
- Copy binary vào thư mục cài.
- Cấu hình NTP (đồng hồ máy sync theo time.google.com — bắt buộc cho bằng chứng pháp lý).
- Cài Windows Service `BetacomAgent` — tự chạy khi máy bật, tự restart khi crash.
- Cài Task Scheduler `BetacomAgentCleanup` — Chủ nhật 03:00 xóa video segment cũ hơn retention (cấu hình ở dashboard).

## 3.1. Cấu hình thời gian lưu video (bắt buộc — làm 1 lần cho mỗi org)

Trước khi giao khách sử dụng, **phải cấu hình retention** trên dashboard:
1. Mở https://betabox.vercel.app/dashboard/settings/warehouse-config (login owner).
2. Nhập số ngày giữ video (VD 45 hoặc 60), bấm **Lưu**.
3. Agent nhận số này qua heartbeat trong ≤30 giây, cache xuống máy kho.

**Nếu chưa cấu hình**: cleanup script sẽ KHÔNG chạy (fail-loud) — ổ đầy dần. Cố ý như vậy: mất dung lượng còn hơn mất bằng chứng do xóa sai.

Số ngày phải ≥ cửa sổ khiếu nại dài nhất của sàn khách bán. Chi tiết đọc ngay trong trang cấu hình.

## 4. Verify sau khi cài

Sau 30-60 giây kể từ khi installer xong:
1. Mở https://betabox.vercel.app/dashboard/videos (login owner của org khách).
2. **KHÔNG** thấy banner "Kho đang offline" → agent kết nối OK.
3. **KHÔNG** thấy banner đỏ "Agent lệch giờ hệ thống" → NTP OK.
4. Vào **Dashboard → Devices → Cameras** → thêm camera RTSP → verify preview hiện được.

## 5. Xử lý lỗi thường gặp

| Triệu chứng | Nguyên nhân | Fix |
|-|-|-|
| Banner "Kho offline" sau 1 phút | Service không start | Mở Services.msc → tìm BetacomAgent → kiểm status. Nếu Stopped → click Start. |
| Banner "Agent lệch giờ" | NTP chưa sync | PowerShell admin: `w32tm /resync` |
| Log agent-stderr.log có `AGENT_SECRET_MISMATCH` | Sai secret | Uninstall + cài lại, nhập đúng secret |
| Log có `Access denied COM7` | PuTTY/Serial Monitor đang giữ cổng | Đóng app đó, restart service |
| Camera thêm nhưng preview đen | Sai URL RTSP hoặc firewall block port | Test URL bằng VLC trên chính máy kho |

Log agent nằm ở `C:\Program Files\BetacomAgent\logs\`:
- `agent-stdout.log` — log bình thường
- `agent-stderr.log` — log lỗi

## 6. Update agent (khi có bản mới)

1. Chép `BetacomAgentSetup-vX.Y.Z-mới.exe` sang máy kho.
2. Run as admin → installer tự nhận biết đã cài, upgrade in-place.
3. Không mất `.env` (giữ nguyên) — không cần nhập lại code/secret.
4. Service tự restart sau upgrade.

## 7. Gỡ agent

Control Panel → Programs → Betacom Warehouse Agent → Uninstall.
Uninstaller tự stop service, remove service, xóa logs + data + .env.
**Video segment `D:\beta_cam_recordings\` KHÔNG bị xóa** (giữ bằng chứng). Xóa tay nếu muốn.
