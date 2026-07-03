# Cài đặt Warehouse Agent lên máy kho

Hướng dẫn cho người lắp máy kho — không cần lập trình. Làm theo thứ tự, không bỏ bước.

## Yêu cầu máy

- Windows 10/11 hoặc Windows Server 2019+.
- Kết nối Internet ổn định (agent cần gọi backend Vercel).
- Cùng LAN với camera IP (RTSP TCP local).
- Tối thiểu 500GB ổ cứng (segment recording tích lũy theo retention).
- USB port cắm scanner mã vạch.

## Bước 1 — BẮT BUỘC bật đồng bộ giờ NTP (KHÔNG BỎ QUA)

**Vì sao bắt buộc:** clip bằng chứng có timestamp cháy trên hình. Nếu giờ máy sai, timestamp clip sai theo → clip mất giá trị pháp lý khi tranh chấp mà **không có dấu hiệu nào cảnh báo**.

### 1.1 Mở PowerShell với quyền Admin

Nhấn `Win`, gõ `powershell`, chuột phải → **Run as administrator**.

### 1.2 Cấu hình Windows Time Service

Copy paste 3 lệnh vào PowerShell:

```powershell
w32tm /config /manualpeerlist:"pool.ntp.org" /syncfromflags:manual /reliable:yes /update
Restart-Service w32time
w32tm /resync
```

### 1.3 Verify đồng bộ thành công

```powershell
w32tm /query /status
```

Phải thấy:
- `Source: pool.ntp.org` (không phải `Local CMOS Clock`).
- `Last Successful Sync Time` cách hiện tại **dưới 5 phút**.
- `Leap Indicator: 0 (no warning)`.

Nếu `Last Successful Sync Time` cách hiện tại quá 1 giờ → NTP CHƯA chạy đúng, không tiếp tục Bước 2 cho tới khi fix xong.

### 1.4 Test âm — chỉnh giờ lệch xem drift có phát hiện không

Sau khi agent chạy (Bước 3), chỉnh giờ máy lùi 2 phút:
```powershell
Set-Date -Date (Get-Date).AddMinutes(-2)
```

Chờ 30-60s → mở dashboard `/dashboard/videos` → phải thấy **banner đỏ** "Agent kho lệch giờ hệ thống". Bấm resync để khôi phục:
```powershell
w32tm /resync
```

Banner phải biến mất trong 30-60s. Nếu không hiện banner → NTP guard không hoạt động, báo lại.

## Bước 2 — Cài Node.js LTS

Tải Node.js LTS (v20 trở lên) từ https://nodejs.org/ → cài mặc định.

Verify:
```powershell
node --version
```
Phải trả về `v20.x.x` hoặc mới hơn.

## Bước 3 — Copy folder agent + config .env

Copy toàn bộ folder `warehouse-agent/` vào `C:\Betacom\warehouse-agent\`.

Trong folder, copy `.env.example` thành `.env` và điền:
```
BACKEND_URL=https://betabox.vercel.app
AGENT_CODE=AGENT_KHO_XX_01
AGENT_SECRET=<lấy từ dashboard admin>
ORG_ID=<lấy từ dashboard admin>
FFMPEG_PATH=C:\Betacom\ffmpeg\ffmpeg.exe
FFPROBE_PATH=C:\Betacom\ffmpeg\ffprobe.exe
RECORDING_DIR=D:\beta_cam_recordings
```

Copy ffmpeg/ffprobe binary từ [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) vào `C:\Betacom\ffmpeg\`.

## Bước 4 — Chạy agent

```powershell
cd C:\Betacom\warehouse-agent
npm install
npm run dev
```

Verify:
- Log agent hiện `Warehouse agent starting — code=...`.
- Dashboard `/dashboard/videos` sau 30s KHÔNG hiện banner "Kho đang offline".

Nếu có banner NTP đỏ ("Agent lệch giờ") → quay lại Bước 1 fix Windows Time.

## Bước 5 — Cắm scanner + camera

- Cắm scanner USB → agent tự phát hiện qua discovery loop (15s).
- Cắm camera IP vào LAN → thêm camera trong `/dashboard/devices`.

## Checklist bàn giao kho

- [ ] Bước 1.3 verify NTP sync < 5 phút trước bàn giao.
- [ ] Bước 1.4 test âm banner NTP hiện + biến mất.
- [ ] Agent online (không có banner offline).
- [ ] Scanner đọc được mã (test 1 mã đơn thật).
- [ ] Camera hiện online trong `/dashboard/devices` (badge emerald).
- [ ] Cắt 1 clip test đầu → verify timestamp burn-in KHỚP với giờ thật máy kho.

Nếu bước cuối cùng lệch giờ dù NTP đã sync → **DỪNG lại, báo dev** — có bug NTP guard không phát hiện được, phải fix trước khi cho kho vận hành thật.
