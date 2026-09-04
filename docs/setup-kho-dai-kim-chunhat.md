# Setup máy kho KĐT Đại Kim — Chủ nhật 26/7/2026

**Người thực hiện:** Hạnh.
**Địa điểm:** kho KĐT Đại Kim.
**Máy đích:** máy tính vận hành ở kho (Windows 10/11 Pro).
**Thời gian ước:** 45-60 phút nếu suôn, 2-3h nếu vướng camera.

Tài liệu này giả định **đã làm xong checklist bước 0-6 ở nhà** trong `checklist-chunhat-26-7.md`. Trước khi đi phải verify:

```sql
-- Chạy trên MCP hoặc Supabase SQL Editor, TRƯỚC KHI đi kho:
SELECT
  (SELECT retention_days FROM organizations WHERE id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8') AS retention,
  (SELECT COUNT(*) FROM warehouses WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8') AS warehouses,
  (SELECT COUNT(*) FROM warehouse_agents WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8') AS agents,
  (SELECT code FROM warehouse_agents WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8' LIMIT 1) AS agent_code,
  (SELECT COUNT(*) FROM packing_stations WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8') AS stations;
```

Kỳ vọng: `retention` không NULL (30 hoặc 45), `warehouses ≥ 1`, `agents = 1` (VD `AGENT_DAI_KIM_01`), `stations ≥ 1`.

**Nếu bất cứ số nào chưa OK: KHÔNG đi kho, quay về checklist bước 1-6 ở nhà.**

Ngoài ra, cầm sẵn `AGENT_SECRET` (đã copy khi tạo agent) — 1 chuỗi ngẫu nhiên, không lưu trong DB dạng plain nữa sau khi tạo, phải Hạnh giữ.

---

## 0. Trước khi rời nhà — kiểm túi đồ

**Bắt buộc cầm theo:**
- USB chứa `BetacomAgentSetup-v0.8.4.exe` (từ `warehouse-agent/dist-installer/`).
- Giấy A4 in ra tài liệu này (mạng kho có thể chập, mở docs online không được).
- Giấy in ra `giao-khach-betacom-ky-vong.md` để bàn giao trưởng kho.
- Sticky note đã viết sẵn: `AGENT_CODE=<...>`, `AGENT_SECRET=<...>`, `BACKEND_URL=https://betabox.betacom.agency`.
- Điện thoại có TeamViewer (dự phòng khi phải hỏi ai đó từ xa).

**Nên cầm theo:**
- Cáp Ethernet dự phòng nếu máy kho dùng LAN (Wi-Fi có thể chập lúc test).
- Cáp USB extend cho máy quét (nếu máy quét cắm xa).
- Điện thoại có 4G phòng khi mạng kho chết.

---

## 1. Đến kho — kiểm môi trường trước khi động máy (10 phút)

**KHÔNG cài agent ngay.** Kiểm 5 điều trước, ghi ra giấy để đối chiếu với giả định ở nhà:

### 1.1. Máy tính kho

- **OS:** Windows mấy? Home hay Pro? (Home KHÔNG cài được nssm service kiểu này — cần Pro. Nếu Home, dừng lại, mua bản Pro hoặc đổi máy.)
- **User đăng nhập:** hiện tại là user gì? Admin hay Standard? (Cần Admin để cài. Sau khi cài xong sẽ tách Standard cho trưởng kho — mục 6 dưới.)
- **RAM:** ít nhất 4GB, khuyến nghị 8GB.
- **Ổ đĩa:** ổ nào có nhiều dung lượng nhất? Ghi lại: `D:\ = ? GB free`, `E:\ = ? GB free`.

**Tính nhanh ổ đầy sau bao lâu:**
```
GB/ngày ≈ số_camera × bitrate_Mbps × 10.55
Ví dụ 3 cam × 4Mbps = 126 GB/ngày.
```
Với retention 30 ngày → cần ~3.8 TB. **Nếu ổ chọn < 4 lần retention_days×GB/ngày, dừng lại, cân nhắc giảm retention hoặc mua ổ ngoài.**

### 1.2. Mạng

- Máy kho dùng LAN hay Wi-Fi? (LAN ổn định hơn cho ghi hình 24/7.)
- Test tốc độ: mở https://fast.com — ít nhất 20 Mbps down, 5 Mbps up.
- Ping tới cloud: mở CMD chạy `ping betabox.betacom.agency` — không mất gói, latency < 100ms.
- Có firewall/proxy công ty chặn HTTPS ra ngoài không? Test bằng: `curl https://betabox.betacom.agency -I` → phải trả `HTTP/2 200` hoặc redirect.

### 1.3. Camera

- Hãng gì? Model gì? Cầm điện thoại chụp lại nhãn sau camera.
- Cắm switch PoE hay đầu ghi NVR? (Ảnh hưởng RTSP path.)
- Địa chỉ IP camera (vào NVR admin xem, hoặc dùng app hãng như iVMS-4200/EZVIZ Studio một lần rồi tắt).
- User + pass RTSP camera. **Tạo tài khoản riêng chỉ-xem-stream** nếu camera hỗ trợ (Hikvision có, EZVIZ hạn chế), tránh dùng tài khoản admin cam.

### 1.4. Máy quét

- Cắm USB → Windows nhận COM mấy? (Mở Device Manager > Ports (COM & LPT).)
- Ghi lại VID/PID (Device Manager > Details > Hardware IDs).
- Test bằng Notepad: mở Notepad → focus → quét thử 1 mã → phải hiện chuỗi mã + Enter.

### 1.5. Camera & máy quét cắm vào ĐÚNG bàn

Kho có mấy bàn đóng gói? Camera nào của bàn nào? Máy quét nào của bàn nào? Vẽ sơ đồ tay:

```
Bàn 01: Camera IP=192.168.1.10, Scanner COM3 VID_1234:PID_5678
Bàn 02: Camera IP=192.168.1.11, Scanner COM4 VID_1234:PID_9ABC
```

**Nếu có bất kỳ bất ngờ nào (Wi-Fi không có mật khẩu, camera không lấy được IP, máy quét không nhận COM):**
Dừng lại, gọi Hạnh (chính Hạnh — ghi lại). Đừng cố ép setup lên môi trường chưa hiểu.

---

## 2. Cài installer (5 phút)

### 2.1. Đăng nhập Admin máy kho

Nếu chưa Admin — chuyển user hoặc chạy `runas /user:Administrator`.

### 2.2. Copy installer từ USB

Copy `BetacomAgentSetup-v0.8.4.exe` từ USB vào `C:\Temp\` (hoặc bất cứ đâu tay Admin ghi được).

### 2.3. Chạy installer

Chuột phải → "Run as administrator". Wizard xuất hiện, điền:

| Field | Giá trị |
|---|---|
| `BACKEND_URL` | `https://betabox.betacom.agency` |
| `AGENT_CODE` | (từ sticky note, VD `AGENT_DAI_KIM_01`) |
| `AGENT_SECRET` | (từ sticky note) |
| `RECORDING_DIR` | Ổ đã chọn ở 1.1, VD `D:\BetacomRecordings` |

**Cảnh giác kép:** không dùng lại `AGENT_KHO_HN_01` (agent org 1 Betacom). Đây là bằng chứng cross-tenant mà xử lý sai = mọi đơn kho khách báo về org Betacom. Cầm sticky note đọc rõ trước khi gõ.

Bấm Next → Install. Installer sẽ:
- Copy file agent + ffmpeg + nssm + cleanup script vào `C:\Program Files\BetacomAgent\`.
- Cài Windows service tên `BetacomAgent` chạy dưới `LocalSystem`.
- Tạo Task Scheduler task `BetacomAgentCleanup` chạy Chủ nhật 03:00.
- Start service ngay.

### 2.4. Verify service chạy

Mở `services.msc` → tìm `BetacomAgent` → phải là **Running**, Startup type **Automatic**.

Nếu **Stopped** hoặc lỗi:
- Mở `C:\Program Files\BetacomAgent\logs\agent-stderr.log`.
- 90% ca là AGENT_SECRET sai — check lại sticky note.
- Nếu log báo network fail — mục 1.2 mạng chưa OK, phải fix trước.

---

## 3. Verify agent kết nối cloud (5 phút)

Trên máy kho hoặc laptop Hạnh (có mạng), mở SQL Editor hoặc chạy MCP:

```sql
SELECT code, last_seen_at, time_drift_seconds,
       EXTRACT(EPOCH FROM (now() - last_seen_at)) AS seconds_ago
FROM warehouse_agents
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8';
```

Kỳ vọng:
- `last_seen_at` cập nhật trong 30 giây gần nhất (`seconds_ago < 30`).
- `time_drift_seconds` giữa -30 và 30 (NTP OK). Nếu > 30 → máy kho lệch giờ, mở Settings > Time & Language > sync time.

**Verify nửa âm — không lẫn org:**
```sql
SELECT wa.code, wa.organization_id, o.name
FROM warehouse_agents wa JOIN organizations o ON o.id=wa.organization_id
WHERE wa.code='AGENT_DAI_KIM_01';
```

Kỳ vọng: tên org phải là **"Betacom kho KĐT Đại Kim"**, KHÔNG phải "Betacom".

Nếu là "Betacom" → **Dừng ngay, gỡ agent**, cài lại với `AGENT_CODE` khác. Đây là ca cross-tenant chưa cắn — nếu để chạy tiếp là dữ liệu khách vào nhầm org Betacom.

---

## 4. Thêm camera + scanner vào dashboard (15 phút)

### 4.1. Mở dashboard trên máy kho

Trình duyệt Edge/Chrome → `https://betabox.betacom.agency/login` → đăng nhập bằng tài khoản **owner org 2** (đã tạo ở nhà).

**Verify header hiển thị đúng org:** góc phải trên phải là "Betacom kho KĐT Đại Kim", KHÔNG phải "Betacom".

### 4.2. Thêm camera

`/dashboard/cameras` → **Thêm camera**:
- Tên: đặt theo bàn (VD "CAM_BAN_01").
- IP + user + pass RTSP (từ mục 1.3).
- Chọn preset đúng hãng (Hikvision/Dahua/EZVIZ/Imou từ dropdown).
- Bấm **Test kết nối** — phải xanh trong 5-10 giây.
- Bấm Lưu.

Lặp cho từng camera.

**Nếu test fail:**
- 90% do user/pass sai. Vào web camera admin (IP:80 trình duyệt), kiểm lại tài khoản RTSP.
- 5% do port RTSP camera không mở (thường 554). Bật trong camera admin.
- 5% do preset sai — thử preset khác.

### 4.3. Thêm scanner (máy quét)

`/dashboard/devices` (hoặc trang thiết bị tương ứng) → **Thêm thiết bị**:
- Type: **scanner**.
- Device code: đặt theo bàn (VD "SCANNER_BAN_01").
- Config: nhập COM port + VID/PID (từ mục 1.4).
- Lưu.

### 4.4. Gán scanner + camera vào station

Đây là **bước ẨN dễ quên nhất** — có bằng chứng org 1 quên bước này khiến 16 đơn không có clip (xem cọc P0.1 vùng C).

Với mỗi bàn:
1. `/dashboard/settings/warehouse-config` → chọn kho KĐT Đại Kim → tab **Bàn**.
2. Chọn station (VD "Bàn 01") → **Gán thiết bị**.
3. Chọn `SCANNER_BAN_01` từ dropdown → Save.
4. Chọn `CAM_BAN_01` từ dropdown → chọn role `proof_primary` → Save.

**Verify bằng SQL sau khi gán:**
```sql
SELECT p.name AS station,
       sd.device_code AS device,
       sd.device_type,
       sd.config_json->>'camera_id' AS camera_uuid,
       sd.config_json->>'role' AS role,
       sda.assigned_at
FROM packing_stations p
JOIN station_device_assignments sda ON sda.station_id=p.id AND sda.unassigned_at IS NULL
JOIN station_devices sd ON sd.id=sda.device_id
WHERE p.organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
ORDER BY p.name, sd.device_type;
```

Mỗi bàn phải có **đúng 2 dòng**: 1 scanner (device_type='scanner') + 1 camera (device_type='camera' với camera_uuid không NULL, role='proof_primary').

**Verify RPC trả đúng camera:**
```sql
SELECT public.resolve_station_camera_at(
  'e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'::uuid,
  '<station_uuid>'::uuid,
  now()
);
```
Phải trả UUID camera, không NULL.

**Nếu NULL → chưa gán camera hoặc gán sai role. KHÔNG đi tiếp mục 5**, mọi đơn sẽ không có clip.

---

## 5. Kiểm end-to-end 1 đơn thật (10 phút)

### 5.1. Quét mã staff mở ca

Trưởng kho (hoặc 1 nhân viên bất kỳ) đưa QR staff cho máy quét bàn 01. Verify:

```sql
SELECT id, staff_id, station_id, status, started_at
FROM staff_work_sessions
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  AND status='active'
ORDER BY started_at DESC LIMIT 5;
```

Kỳ vọng: 1 row status='active' vừa tạo, station_id đúng bàn 01.

### 5.2. Quét mã đơn thử

Đưa 1 mã đơn thật (từ tem đóng gói) cho máy quét bàn 01. Verify:

```sql
SELECT waybill_code, status, station_id, proof_camera_id, scanned_at
FROM packing_events
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
ORDER BY scanned_at DESC LIMIT 3;
```

Kỳ vọng:
- `status='valid'` (không `unmapped_scanner`, không `no_active_session`).
- `proof_camera_id` **KHÔNG NULL** (nếu NULL → mục 4.4 gán camera thiếu).

### 5.3. Xem clip

`/dashboard/videos` → tìm đơn vừa quét → bấm xem.

**Đơn đầu tiên có thể chờ ~1 phút** (segment ffmpeg 60s, phải đóng segment mới cắt được). Nếu >2 phút vẫn báo "Cắt clip thất bại: signed_url_failed: bucket_missing" → chờ thêm hoặc bấm Thử lại. Nếu vẫn fail sau 5 phút, kiểm:

```sql
SELECT id, status, error_message, created_at
FROM order_proof_clips
WHERE packing_event_id=(
  SELECT id FROM packing_events
  WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  ORDER BY scanned_at DESC LIMIT 1
);
```

Nếu status='failed' + error_message có nội dung → đọc để chẩn đoán. Gọi Hạnh (chính Hạnh) nếu không hiểu.

### 5.4. Nửa âm — không lẫn org Betacom

Đăng xuất trưởng kho → đăng nhập lại bằng tài khoản Hạnh (owner org 1 Betacom). Vào `/dashboard/videos` — **KHÔNG được thấy** đơn vừa quét ở kho KĐT Đại Kim.

Nếu thấy → **cross-tenant leak thật, dừng ngay, gọi ngay chính Hạnh** (nghĩa gọi 1 dev khác nếu có, hoặc thoát ra bàn ghi cọc — bug này chưa từng verify hôm nay).

---

## 6. Tách tài khoản Windows cho trưởng kho (10 phút)

Máy kho hiện đang login Admin. Chuyển sang mô hình Admin (Hạnh) + Standard (trưởng kho):

```powershell
# Từ Admin PowerShell:
$password = ConvertTo-SecureString "MạtKhẩuMạnh" -AsPlainText -Force
New-LocalUser -Name "kho" -Password $password -FullName "Trưởng kho KĐT Đại Kim" -Description "Vận hành hằng ngày"
Add-LocalGroupMember -Group "Users" -Member "kho"
```

Đăng xuất Admin → đăng nhập `kho` → verify:

1. Dashboard mở được (trình duyệt vẫn dùng được).
2. Máy quét USB nhận (test bằng Notepad + quét thử).
3. **CommandLine ffmpeg KHÔNG lộ mật khẩu camera cho Standard User:**
   ```powershell
   Get-Process ffmpeg | Select-Object CommandLine
   ```
   Kỳ vọng: cột trống hoặc "Access denied" — vì service chạy dưới `LocalSystem`, Standard User không đọc process khác user.

Nếu trưởng kho cần cài phần mềm khác (Zalo, TeamViewer, v.v.) → **tạm login Admin, cài xong đăng xuất về Standard**. KHÔNG cấp Admin cho trưởng kho dùng hằng ngày.

**Nếu vì lý do gì phải cấp Admin cho trưởng kho:** gọi Hạnh xin duyệt + ghi vào note "kho X có Admin, ngày Y" để lần sau nhớ mật khẩu RTSP camera lộ với ai.

---

## 7. Bàn giao trưởng kho (10 phút)

Đưa giấy `giao-khach-betacom-ky-vong.md`. Cùng trưởng kho làm 5 việc trong mục 8 checklist của file đó:

- [ ] Mở dashboard, đăng nhập.
- [ ] Kiểm phần Máy trạm + Cameras xanh/đỏ.
- [ ] Tìm 1 đơn thật trong /dashboard/videos, cắt clip xem.
- [ ] Bấm [Thử lại] một lần cho biết cảm giác.
- [ ] Tải 1 clip về máy.

Trưởng kho ký. Hạnh ký. Chụp ảnh giấy đã ký, lưu Drive.

**Số ghi cho Hạnh cầm về:**
- Ổ đích: `D:\` (hoặc E:\) free bao nhiêu GB **sau khi setup**.
- Ổ đầy sau bao nhiêu ngày (tính theo mục 1.1).
- Số camera thực tế cài được / kế hoạch.
- Vấn đề gì vướng, đã workaround gì.

---

## 8. Sau khi rời kho — theo dõi từ xa 24-72 giờ đầu (làm ở nhà)

Mỗi sáng thứ Hai-Ba-Tư, mở:

```sql
-- 1. Agent còn kết nối?
SELECT code, last_seen_at,
       EXTRACT(EPOCH FROM (now() - last_seen_at))/60 AS minutes_ago
FROM warehouse_agents
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8';
-- minutes_ago > 5 = agent đã mất kết nối, gọi trưởng kho kiểm máy còn bật không.

-- 2. Có log warn/error nào từ agent không?
SELECT emitted_at, level, message
FROM agent_log_events
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  AND emitted_at > now() - interval '24 hours'
ORDER BY emitted_at DESC LIMIT 50;
-- Đọc từng dòng warn/error, chẩn đoán nếu có gì lạ.

-- 3. Bao nhiêu đơn quét được, bao nhiêu có clip?
SELECT status, COUNT(*),
       COUNT(*) FILTER (WHERE proof_camera_id IS NOT NULL) AS with_camera
FROM packing_events
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  AND scanned_at > now() - interval '24 hours'
GROUP BY status;
-- Kỳ vọng: status='valid' chiếm >95%, with_camera = count (không có NULL).

-- 4. Bao nhiêu clip cắt thành công vs failed?
SELECT status, COUNT(*)
FROM order_proof_clips opc
JOIN packing_events pe ON pe.id=opc.packing_event_id
WHERE opc.organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  AND opc.created_at > now() - interval '24 hours'
GROUP BY status;
-- Kỳ vọng: 'ready' chiếm đa số; 'failed' phải có error_message rõ để đọc.
```

**Bất thường phải gọi trưởng kho kiểm ngay:**
- Agent `minutes_ago > 5` → máy hoặc mạng.
- `packing_events` status khác valid > 10% → cấu hình quét/session sai.
- `proof_camera_id NULL` xuất hiện → gán camera hỏng.
- `order_proof_clips.status='failed'` > 10% → đọc error_message.

---

## 9. Kịch bản dự phòng — cái gì có thể sai

### 9.1. Vercel deploy fail giữa lúc đang setup
Đã ổn định `efeae25`. Nhưng nếu Chủ nhật Hạnh push commit gì đó phải build lại và fail — dừng, không cài agent đang lúc cloud không ổn. Verify bằng `curl https://betabox.betacom.agency -I` → 200.

### 9.2. Camera không nhận preset
Có thể là camera hãng lai (ODM), preset chuẩn không cover. Vào web camera admin → mục "RTSP" → xem stream URL cụ thể → nhập tay vào cấu hình camera bên dashboard (nếu có ô "Custom RTSP URL").

### 9.3. Máy quét không nhận COM
Đôi khi Windows tự giả lập máy quét USB thành HID (Human Interface Device) thay vì COM. Vào Device Manager > Human Interface Devices → tìm máy quét → có thể phải cài driver hãng để chuyển sang COM.

### 9.4. Firewall/proxy chặn HTTPS 443 outbound
Kho có IT riêng có thể chặn. Test bằng `curl https://betabox.betacom.agency -I`. Nếu không được → yêu cầu IT kho whitelist `betabox.betacom.agency`, `lpmngnbstfuswmodjtgu.supabase.co`, `*.supabase.co`, `*.googleapis.com` (Turnstile).

### 9.5. Camera EZVIZ dùng cloud của EZVIZ (không mở RTSP local)
EZVIZ mặc định TẮT RTSP để buộc dùng app EZVIZ. Vào EZVIZ Studio hoặc app EZVIZ → Settings > Encrypt → tắt Video Encryption → mở RTSP local mode.

### 9.6. Trưởng kho lo "camera có ghi âm không"
Trả lời trước khi ai hỏi: "Có, RTSP mặc định lấy cả video + audio. Nếu không muốn ghi âm, tắt microphone trong web camera admin." Ghi vào giấy giao khách nếu khách yêu cầu.

### 9.7. Cúp điện giữa lúc cài
Agent có 3 tầng boot recovery. Sau cúp điện bật lại máy → service tự start → boot recovery quét file segment cũ đưa vào index. Verify bằng: `SELECT * FROM agent_log_events WHERE level IN ('warn','error') AND emitted_at > now() - interval '10 minutes'` — không có row lạ là ok.

---

## Cấm cứng — không phá quy tắc đã ghi trong buổi rà

- **KHÔNG cấp role `admin` cho ai ở kho** (bug leo thang admin→owner chưa fix hoàn toàn — dù đã có canAssignRole chặn, nhưng vẫn giữ nguyên tắc "không cấp admin cho người ngoài Hạnh").
- **KHÔNG dùng lại `AGENT_KHO_HN_01`** cho máy kho khách.
- **KHÔNG bấm Hủy khi form tạo user đang chờ** — có thể tạo bản ghi trùng (cọc project_post_users_thieu_try_catch_bao_ngoai_2026_07_24).
- **KHÔNG cài phần mềm quản lý camera khác** (iVMS, EZVIZ Studio) lên máy đang chạy BetacomAgent — xung đột.
- **KHÔNG tự đổi cấu hình camera qua web admin** khi agent đang ghi — có thể đổi codec/resolution làm ffmpeg drop.

---

## Sau Chủ nhật — tuần sau còn phải làm

Nợ đã ghi cọc, không blocker Chủ nhật nhưng phải nhớ:

1. `supabase migration repair --status applied 20260723173403` sau khi dọn drift bulk.
2. Copy pattern try/catch signup route sang POST /api/users + POST /api/staff/[id]/invite (bug rollback mồ côi).
3. Xử tiếp vùng D/E/F nếu Hạnh quyết rà.
4. Disk guard thật (statfs check trước spawn) — cần trước khách thứ 2.
5. Fix ENOSPC classify trong agent (gộp với disk guard).
