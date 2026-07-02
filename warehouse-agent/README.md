# Warehouse Local Agent

Đọc mã từ máy quét (KAW-K136 chạy Virtual COM, CH340) và gửi raw scan event
lên backend Next.js qua endpoint `POST /api/warehouse/scans`. Request được ký
HMAC-SHA256 bằng `AGENT_SECRET`, không dùng JWT của user.

Đây là một app Node.js TypeScript độc lập trong repo. Nó **không** được kéo
vào Next.js build vì `serialport` cần native binding chỉ chạy được trên máy
local Windows / Linux / macOS.

---

## 1. Cài dependency

```powershell
cd warehouse-agent
npm install
```

Lưu ý: `serialport` sẽ tự build/native-prebuilt binding cho Windows + Node 20.
Nếu máy chưa có Visual Studio Build Tools và prebuild không có sẵn, npm có thể
yêu cầu cài thêm tool. Trong đa số trường hợp prebuild có sẵn — không cần
thao tác gì thêm.

## 2. Cấu hình env

```powershell
copy .env.example .env
```

Sửa `.env`:

```env
BACKEND_URL=http://localhost:3000
AGENT_CODE=AGENT_KHO_HN_01
AGENT_SECRET=dev_secret_change_me_a1b2c3d4e5f6
SCANNERS_JSON=[{"scanner_device_code":"SCANNER_BAN_01","port":"COM7","baudRate":9600}]
```

- `AGENT_CODE` phải khớp với `warehouse_agents.code` trong Supabase.
- `AGENT_SECRET` phải khớp với `warehouse_agents.secret` của cùng row.
- Đổi `COM7` thành cổng máy quét đang dùng (xem mục 3).
- Nhiều scanner: thêm phần tử vào `SCANNERS_JSON`, ví dụ:
  `[{...COM7...},{"scanner_device_code":"SCANNER_BAN_02","port":"COM8","baudRate":9600}]`

## 3. Liệt kê cổng COM hiện có

```powershell
npm run list-ports
```

Ví dụ output:

```
COM7 - wch.cn USB-SERIAL CH340 (COM7) 7523 1A86
```

Lấy đường dẫn `COM7` và dán vào `SCANNERS_JSON.port`.

## 4. Đảm bảo PuTTY đã đóng

**Một cổng COM chỉ được mở bởi một process.** Nếu PuTTY (hoặc Arduino IDE,
Serial Monitor, vv) đang giữ COM7, agent sẽ báo lỗi `Access denied` /
`Resource busy`. Đóng hết các app đang mở COM trước khi chạy.

## 5. Chạy agent (dev)

```powershell
npm run dev
```

Output mong đợi:

```
Warehouse agent starting — code=AGENT_KHO_HN_01, backend=http://localhost:3000, scanners=1
Opened COM7 for SCANNER_BAN_01 @ 9600 baud
```

## 6. Test bằng máy quét KAW-K136

1. Đảm bảo KAW-K136 đã được cấu hình về **Virtual COM (USB CDC)**.
   Trên Windows Device Manager nó hiển thị: `USB-SERIAL CH340 (COM7)`.
2. Đảm bảo dev server Next.js đang chạy: `npm run dev` ở repo gốc.
3. Khởi động agent (mục 5).
4. Quét một mã bất kỳ (mã waybill SPX, mã QR nhân sự `STAFF_CHECKIN:...`, vv).
5. Terminal agent in:
   ```
   [OK] SCANNER_BAN_01 COM7 -> SPXVN123456789
   ```
6. Vào Supabase Studio → table `warehouse_scan_raw_events`, sẽ thấy record mới
   với:
   - `raw_value` = mã vừa quét
   - `scan_type` = `waybill` (hoặc `staff_qr` nếu mã bắt đầu bằng `STAFF_CHECKIN:`)
   - `scanner_device_code`, `port`, `scanned_at` đúng giá trị
7. Row `warehouse_agents` của AGENT_KHO_HN_01 sẽ có `last_seen_at` được update.

## 7. Build & chạy production

```powershell
npm run build
npm start
```

`npm start` chạy file đã compile trong `dist/`.

## 8. Cơ chế retry

Nếu backend offline hoặc trả lỗi, scan được append vào
`warehouse-agent/data/pending-scans.jsonl`. Mỗi 5 giây (mặc định) agent đọc
file, retry từng item, ghi đè file với những item chưa gửi được. Khi retry
thành công log có tiền tố `[OK-RETRY]`.

## 9. Tự reconnect khi mất cổng COM

Khi rút dây máy quét hoặc cổng đóng đột ngột, agent sẽ log lỗi và tự gọi lại
`SerialPort.open()` sau `RECONNECT_DELAY_MS` (mặc định 5 giây). Cắm lại dây
là agent tự nối lại — không cần restart.

## 10. Seed agent test (SQL)

Org "Betacom Demo" có id `00000000-0000-0000-0000-000000000001`. Seed một
agent với secret khớp `.env`:

```sql
insert into public.warehouse_agents (organization_id, code, name, secret, status)
values (
  '00000000-0000-0000-0000-000000000001',
  'AGENT_KHO_HN_01',
  'Máy kho Betacom Demo',
  'dev_secret_change_me_a1b2c3d4e5f6',
  'active'
)
on conflict (code) do update
  set name = excluded.name,
      secret = excluded.secret,
      status = excluded.status;
```

> Lưu ý: secret được lưu plain trong DB. RLS chỉ cho `authenticated` SELECT
> (không có policy insert/update/delete), nên chỉ service-role key của
> backend mới ghi/đọc được cột này. Khi cần nâng cấp, đổi sang
> envelope-encryption với KMS key.

## 11. Phần cố tình **chưa** làm ở phase này

- Chưa tạo `staff_work_sessions`. Agent không biết ai đang ca trực.
- Chưa tạo bảng `orders`. Mọi mã waybill chỉ được lưu raw.
- Chưa xử lý duplicate (cùng `raw_value` quét nhiều lần).
- Chưa map `scanner_device_code` → station/warehouse.
- Chưa xử lý `no_active_session` / cảnh báo nghiệp vụ.
- Camera, OCR, đối soát ảnh — chưa có.

Đó là phạm vi phase sau. Hiện tại agent chỉ làm đúng một việc:
**đọc scanner và đẩy event lên backend ổn định**.
