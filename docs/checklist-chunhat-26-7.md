# Checklist giao khách 1 — Chủ nhật 26/7/2026

**Người cầm tay: Hạnh.** Không đưa cho trưởng kho / khách. Chứa AGENT_SECRET, query DB, quy tắc nội bộ (bug leo thang chưa fix).

Ngữ cảnh: 2 org sống. Org 1 = Betacom (id `00000000-0000-0000-0000-000000000001`, `AGENT_KHO_HN_01`). Org 2 = KĐT Đại Kim (id `e3cb7cd1-e869-4d55-936d-5bcb1a1467b8`, owner `full_name="Betacom"` cần đổi, chưa có warehouse/agent/camera).

---

## Nguyên tắc tách việc

**Ở nhà (hôm nay–thứ Sáu 24/7):** làm hết bước 0-6 + verify. Nếu có trục trặc, phát hiện tại nhà, còn thời gian sửa.

**Ở kho (Chủ nhật 26/7):** chỉ bước 7 (cài agent) + kiểm end-to-end. Không setup DB/deploy ở kho — khách ngồi cạnh, Vercel build fail thì kẹt.

## Quy tắc cứng cầm tay Chủ nhật

Nếu ở kho gặp trục trặc và nghĩ *"cấp `admin` cho ai đó để nhanh"* → **DỪNG. Gọi lại. KHÔNG cấp `admin`.**

Lý do: có bug leo thang admin→owner chưa fix ([src/app/api/users/[id]/route.ts:84-89](src/app/api/users/[id]/route.ts#L84-L89) + [src/app/api/staff/[id]/invite/route.ts:36-46](src/app/api/staff/[id]/invite/route.ts#L36-L46)). Chỉ dùng `owner` (Hạnh) + `warehouse_manager` (trưởng kho) + `packer`/`viewer`.

---

## Bước 0 — Deploy fix P0.1 (làm hôm nay)

Fix đã commit local (`cd26e5c`) chưa push. Review diff rồi push.

```bash
git log --oneline -1        # confirm cd26e5c
git show HEAD               # xem diff 1 dòng
git push origin main        # push → Vercel auto-deploy
```

**Verify sau deploy** (phải phân biệt lỗi từ route vs lỗi từ middleware):

```bash
curl -X POST https://<domain>/api/agent/verify-clip-stale-marker
```

- ✅ Đúng: response body có `missing_agent_headers` / `invalid_signature` / tương tự **từ route**.
- ❌ Sai: response body `{"error":"unauthenticated"}` từ middleware → fix chưa ăn, kiểm lại prefix chính tả.

**Tùy chọn — kèm theo fix UI P1.1 vùng C**: thêm case `invalid_code` vào [src/app/dashboard/packing/scan/page.tsx:152-166](src/app/dashboard/packing/scan/page.tsx#L152) — 3 dòng:
```jsx
} else if (status === "invalid_code") {
  toast.error("Mã quét không hợp lệ (trống hoặc chỉ khoảng trắng). Quét lại.");
}
```
Fix và deploy cùng lúc với whitelist. Effort 5 phút. Rủi ro thấp, không đụng backend.

## Bước 1 — Set `retention_days` cho org 2

Impersonate org 2 từ `/platform` → `/dashboard/settings/warehouse-config` → đặt số Hạnh chốt (VD 30 hoặc 45).

**Verify:**
```sql
SELECT retention_days FROM organizations
WHERE id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8';
```
Không NULL.

*Ghi chú:* NULL không phá gì (video vẫn ghi, cleanup không xóa, resolver không báo quá hạn nhầm). Đầy ổ sau ~30 ngày. Set để an toàn dài hạn.

## Bước 2 — Tạo warehouse cho org 2

Impersonate → `/dashboard/warehouses` → New → code kho (VD `KDT_DAI_KIM`), name, address.

**Verify:**
```sql
SELECT id, code, name FROM warehouses
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8';
```
1 row.

## Bước 2b — Gán camera vào station (bước ẨN, dễ quên nhất)

**Đây là bước sản phẩm hỏng ngay nếu quên.** DB org 1 có bằng chứng: 16 đơn NULL `proof_camera_id` trước 29/6 vì quên bước này. Trưởng kho quét → mọi đơn không có clip.

Camera-station mapping đi qua 2 bước ẩn (không phải bảng `packing_stations.camera_id` như thường nghĩ):

1. **Tạo station_device type='camera'**: Impersonate org 2 → `/dashboard/settings/warehouse-config` (hoặc trang thiết bị) → New device → chọn `device_type='camera'`, chọn camera từ dropdown → save. Backend sẽ set `station_devices.config_json = {"camera_id":"<UUID>","role":"proof_primary"}`.

2. **Assign device vào station**: cũng trang thiết bị → gán device camera vào station.

**Verify NỬA DƯƠNG + NỬA ÂM một query:**
```sql
SELECT p.name AS station,
       sd.device_code AS camera_device,
       sd.config_json->>'camera_id' AS camera_uuid,
       sda.assigned_at, sda.unassigned_at
FROM packing_stations p
LEFT JOIN station_device_assignments sda ON sda.station_id = p.id AND sda.unassigned_at IS NULL
LEFT JOIN station_devices sd ON sd.id = sda.device_id AND sd.device_type = 'camera'
WHERE p.organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
ORDER BY p.name;
```

**Mỗi station org 2 phải có 1 row với camera_uuid không NULL và unassigned_at IS NULL.** Nếu station nào có row null hoặc thiếu → chưa gán camera → **KHÔNG BẤM QUÉT ĐƠN**, quay lại setup.

**Verify song song** RPC trả đúng (thay UUID station + thời điểm hiện tại):
```sql
SELECT public.resolve_station_camera_at(
  'e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'::uuid,
  '<station-uuid>'::uuid,
  now()
);
```
Trả về UUID camera, không NULL.

## Bước 3 — Tạo warehouse_agent RIÊNG cho org 2

Impersonate → trang quản lý agent → New agent.

- **CODE MỚI**: `AGENT_DAI_KIM_01` (không giống `AGENT_KHO_HN_01` của org 1).
- **COPY AGENT_SECRET** mới sinh — lưu chỗ an toàn, dùng cho installer .iss bước 7.

**Verify (nửa dương + nửa âm cùng lúc — nhìn 2 dòng cạnh nhau):**
```sql
SELECT code, organization_id, created_at
FROM warehouse_agents
ORDER BY created_at DESC LIMIT 5;
```
Phải thấy:
- `AGENT_DAI_KIM_01` → `e3cb7cd1-...` (org 2, mới tạo).
- `AGENT_KHO_HN_01` → `00000000-...` (org 1, vẫn nguyên).

Hai dòng, hai org khác nhau. Nếu chỉ 1 dòng hoặc cùng org → dừng, kiểm lại impersonate context.

> ⚠️ **CẠNH CỨNG**: TUYỆT ĐỐI KHÔNG dùng lại `AGENT_KHO_HN_01` cho máy kho khách. Dùng nhầm = mọi dữ liệu kho khách báo về org 1. Loại leak khó phát hiện (mọi thứ chạy bình thường, chỉ nằm sai org).

## Bước 4 — Sửa `full_name` owner org 2

Impersonate → `/dashboard/users` → tài khoản owner org 2 (hiện tên "Betacom") → sửa thành tên thật của trưởng kho.

**Verify:**
```sql
SELECT full_name, role FROM user_profiles
WHERE organization_id='e3cb7cd1-e869-4d55-936d-5bcb1a1467b8'
  AND role='owner';
```
Không còn "Betacom".

## Bước 5 — (Tùy chọn) Tạo tài khoản `warehouse_manager`

Nếu tách vai trò: owner org 2 = Hạnh quản lý, WM = trưởng kho login hằng ngày.

Nếu để owner = trưởng kho (đơn giản hơn): bỏ bước này, đổi mật khẩu owner cho trưởng kho.

## Bước 6 — Cấu hình webhook Lark (nếu dùng)

Impersonate → `/dashboard/settings/warehouse-config` → tab kho → paste webhook URL Lark.

URL phải bắt đầu `https://open.larksuite.com/open-apis/bot/v2/hook/` (server-side validator từ chối URL khác — [src/app/api/warehouses/[id]/route.ts:14-29](src/app/api/warehouses/[id]/route.ts#L14-L29)).

Bật `notify_lark_enabled`.

**Test tại trang cùng**: bấm nút test (route [src/app/api/warehouses/[id]/test-lark/route.ts](src/app/api/warehouses/[id]/test-lark/route.ts) — có nút gọi ở page.tsx). Verify tin đến nhóm Lark khách.

*Nếu nút không có ở UI (khả năng thấp, page.tsx đang gọi):* quét 1 đơn lỗi thật ở bước 8 sẽ tự trigger notify — coi đó là verify.

## Bước 7 — Chủ nhật ở kho: cài agent máy kho

Chạy installer .iss với:
- `AGENT_CODE` = `AGENT_DAI_KIM_01`
- `AGENT_SECRET` = giá trị copy ở bước 3
- `BACKEND_URL` = domain production
- `RECORDINGS_DIR` = ổ đủ dung lượng cho retention đã set

**Verify agent kết nối:**
```sql
SELECT code, last_seen_at, time_drift_seconds
FROM warehouse_agents
WHERE code='AGENT_DAI_KIM_01';
```
`last_seen_at` cập nhật trong 30s sau service start. `time_drift_seconds` < 30 (NTP ok).

**Verify agent không nhầm org (paranoia check):**
```sql
SELECT wa.code, wa.organization_id, o.name
FROM warehouse_agents wa
JOIN organizations o ON o.id = wa.organization_id
WHERE wa.code='AGENT_DAI_KIM_01';
```
Phải là "Betacom kho KĐT Đại Kim", không phải "Betacom".

## Bước 7b — Ghi dung lượng ổ + tính tốc độ tích

Sau khi cài agent (bước 7), TRƯỚC khi bấm quét đơn đầu tiên:

**Ghi lại dung lượng ổ trống hiện tại** (ổ chứa `RECORDING_DIR`):
```powershell
Get-PSDrive -Name D  # đổi D thành ổ thật
# Ghi vào doc: Free_GB = ?
```

**Tính tốc độ tích ước tính:**
```
Số camera × bitrate (Mbps) × 3600 × 24 / 8 / 1024 = GB/ngày
Ví dụ: 3 cam × 4 Mbps × 3600 × 24 / 8 / 1024 = ~126 GB/ngày
```

Bitrate lấy từ `Get-Process ffmpeg | Select CommandLine` hoặc mặc định cam Hikvision H.264 720p ~2-4 Mbps, 1080p ~4-8 Mbps.

**Ước tính "ổ đầy sau bao lâu"** = Free_GB / (GB/ngày).

**Ghi 2 con số này vào doc bàn giao khách 1:**
- Free_GB = ___
- Ổ đầy sau ___ ngày với retention hiện tại

**Nếu < 2 × retention_days** → không đủ dư an toàn, cân nhắc giảm retention hoặc thêm ổ TRƯỚC khi Chủ nhật cài. Nếu > 3 × retention_days → OK, kiểm chủ động tuần đầu qua TeamViewer.

*Lý do làm bước này thay vì fix classify ENOSPC trong agent*: bug ENOSPC classify là P1 (Hạnh thấy chậm ~1h, không mất video), fix rebuild agent = đụng đường sống 3 ngày trước go-live. Bước 7b rẻ hơn nhiều và giải root: biết trước ổ đầy khi nào thì không cần agent báo.

## Bước 7c — Tạo Standard User Windows cho trưởng kho

Máy kho thường cài sẵn tài khoản Admin duy nhất. Đề tách:
- **Admin (Hạnh dùng qua TeamViewer khi cần)**: cài phần mềm, sửa service, đọc log.
- **Standard User (trưởng kho dùng hằng ngày)**: mở dashboard qua browser, bấm quét, xem clip.

**Xác nhận trước khi làm**: agent chạy Windows Service dưới `LocalSystem` ([installer betacom-agent.iss:272-281](warehouse-agent/installer/betacom-agent.iss#L272-L281) không set `ObjectName` = mặc định NSSM = LocalSystem). Cleanup Task cũng SYSTEM. Standard User đăng nhập KHÔNG ảnh hưởng agent + cleanup.

**Cách làm** (~10 phút, khi cài):
```powershell
# Từ Admin PowerShell:
$password = ConvertTo-SecureString "MạtKhẩuMạnh" -AsPlainText -Force
New-LocalUser -Name "kho" -Password $password -FullName "Trưởng kho KĐT Đại Kim" -Description "Vận hành hằng ngày"
Add-LocalGroupMember -Group "Users" -Member "kho"

# Set trưởng kho tự đăng nhập khi boot (tùy chọn — nếu muốn máy tự vào Windows sau khi bật)
# Kích chuột phải Start > Computer Management > Local Users → tick "User must change password at next logon" hoặc bỏ tùy chọn
```

**Verify sau khi tạo:**
1. Đăng xuất Admin → đăng nhập "kho" (Standard).
2. Mở browser → dashboard vẫn login được.
3. Máy quét cắm USB → COM port vẫn nhận (test bằng quét 1 mã đơn giả).
4. Từ Standard User, chạy `tasklist /V` — CommandLine ffmpeg **KHÔNG hiển thị** (vì service LocalSystem, Standard User không đọc process khác user). **Verify nửa âm**: `Get-Process ffmpeg | Select CommandLine` từ Standard User → cột trống hoặc "Access denied" → **credential plaintext KHÔNG lộ cho trưởng kho**.

**Nếu vì lý do gì phải để trưởng kho dùng Admin** (VD cần sửa cấu hình gì): giữ hoãn cọc credential plaintext, ghi ngữ cảnh đã đổi (trưởng kho Admin) vào memory để lần sau rà lại biết.

## Bước 8 — Kiểm end-to-end 1 đơn thật

> ⚠️ **Đơn đầu tiên có thể chờ ~1 phút để có clip.** Segment ffmpeg mặc định 60s → agent vừa boot, segment đầu chưa đóng → resolver trả `segment_still_open` → client poll đợi. **Đây là bình thường, không phải lỗi.** Sau đơn thứ 2 trở đi chỉ ~15-20s.

Ở kho, với trưởng kho quét thật:
1. Quét 1 mã đơn → xem `/dashboard/videos` (org 2, không impersonate — login trưởng kho hoặc Hạnh có tài khoản org 2) thấy row mới.
2. Đợi ~1 phút → bấm xem clip → clip mở, video đúng camera đúng thời điểm.
3. Quét 1 mã đơn LỖI (trùng/không session) → verify tin Lark đến nhóm khách (nếu đã cấu hình bước 6).

**Nửa âm — kiểm không lẫn org 1:**
- Login lại tài khoản org 1 (Hạnh nội bộ) → `/dashboard/videos` KHÔNG thấy đơn vừa quét ở kho khách.
- Login owner org 2 → thấy đơn vừa quét, KHÔNG thấy dữ liệu org 1 (88 packing_events cũ, 32 clip cũ).

---

## Nếu có sự cố ở kho

- **Agent không kết nối**: kiểm log `%PROGRAMDATA%\WarehouseAgent\logs\agent.log` — network / BACKEND_URL / SECRET sai.
- **Camera không ghi**: `/dashboard/cameras` xem `last_probe_ok` + `probe_consecutive_fails` — camera vật lý offline khác agent bug.
- **Cần role đặc biệt cho trưởng kho**: chỉ cấp `warehouse_manager`. KHÔNG cấp `admin`. Có gì gọi Hạnh remote qua TeamViewer.

## Sau Chủ nhật (tuần sau)

- Fix bug leo thang admin→owner (P0.2 trong báo cáo vùng B).
- CI guard: mọi route trong `src/app/api/agent/**` PHẢI có prefix trong PUBLIC_API_PREFIXES.
- Set `retention_days` NOT NULL DEFAULT trên `organizations` (khi có windows migration nhẹ nhàng).
- Verify script cross-tenant tổng thể (Gate 2 đầy đủ) — trước khách 3 hoặc mở signup.
