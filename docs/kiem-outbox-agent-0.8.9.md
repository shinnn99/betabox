# Ca kiểm agent 0.8.9 — outbox callback clip-cut-result

Kiểm trên **máy HN_01 (SHINN, org Betacom Demo)** trước khi đụng máy kho
khách. Máy này không có camera sống, nhưng **không cần** camera: org demo
đã có 2434 file segment trên ổ và bảng `camera_recording_files` phủ đúng
cửa sổ của packing event dưới đây, nên lệnh cắt chạy thật được.

**Đối tượng kiểm:** `PE 196d4be0-011a-47e1-acb1-380095bec878` — mã
`GYXQFGUD`, quét 13/07/2026 17:25 (giờ VN), camera `cam_01`
(`5ce23718-0737-43bb-a1dc-7646e87c0a89`), `timing_status=default_estimated`
(đơn đã đóng nên qua được cổng proof-clip-gate).

---

## Vì sao cần hai ca, không phải một

Luồng cắt **thành công** không chạm outbox một dòng nào — code mới nằm im.
Xanh kiểu đó là xanh vì không kích, không phải vì fix ăn.

Bug gốc gồm hai nửa, phải kiểm riêng từng nửa:

| Nửa | Câu hỏi | Ca |
|---|---|---|
| Ghi | callback fail thật thì agent có ghi lại không? | A |
| Drain | có item trong hàng đợi thì gửi lại được không? | B |

Ca A là nửa mà bug gốc nằm ở đó. Bỏ ca A thì coi như chưa kiểm fix này.

## Vì sao phải dùng proxy, không đổi thẳng BACKEND_URL sang host chết

Đổi sang host chết thì agent **không poll được lệnh** → không có lệnh cắt
nào để mà fail callback → ca kiểm rỗng. Sự cố thật cũng không có hình
dạng đó: `poll-commands` và `command-result` đi VPS bình thường, riêng
`clip-cut-result`/`clip-upload-url` trúng Vercel cũ. Proxy
`warehouse-agent/scripts/fail-clip-result-proxy.mjs` tái hiện đúng hình
dạng đó — pass hết, ép 451 đúng một endpoint.

HMAC v2 ký `method + canonicalPath + body`, **không ký host**, nên
forward nguyên headers + body là chữ ký vẫn hợp lệ.

---

## Chuẩn bị

```powershell
# 1. Sao lưu .env agent TRƯỚC khi sửa
Copy-Item 'C:\Program Files\BetacomAgent\.env' 'C:\Program Files\BetacomAgent\.env.bak-truoc-ca-kiem'

# 2. Trỏ agent qua proxy
#    BACKEND_URL=http://127.0.0.1:8099
notepad 'C:\Program Files\BetacomAgent\.env'

# 3. Cài exe 0.8.9 (hoặc chạy trực tiếp exe vừa build để khỏi đụng service)
#    warehouse-agent\dist-exe\betacom-agent.exe
```

Kiểm phiên bản đúng là 0.8.9 trước khi bắt đầu — kiểm nhầm bản cũ là mất
cả buổi.

---

## Ca A — nửa ghi (callback fail → phải ghi outbox)

```bash
# terminal 1 — proxy ở chế độ ép 451
cd warehouse-agent
node scripts/fail-clip-result-proxy.mjs
```

```powershell
# terminal 2 — agent
Restart-Service BetacomAgent   # hoặc chạy thẳng betacom-agent.exe
```

Trên dashboard (org Betacom Demo) → **Video** → tìm `GYXQFGUD` → bấm
**Tạo clip**. Dùng đúng đường user thật, không chọc RPC bằng tay.

**Phải thấy đủ ba dấu:**

1. Log proxy: `POST /api/agent/clip-cut-result → 451 (giả lập Vercel cũ)`
2. Log agent: `[clip-outbox] xếp hàng callback clip=<uuid> outcome=failed: http_451`
3. File `C:\Program Files\BetacomAgent\data\pending-clip-results.jsonl`
   có đúng 1 dòng, và **không chứa chuỗi `agentSecret`**.

**Trạng thái row clip phụ thuộc cloud đã deploy chưa** — đây chính là
bằng chứng trước/sau của bản vá cloud:

| Cloud | Row `order_proof_clips` | Ý nghĩa |
|---|---|---|
| chưa có `c48d159` | kẹt `pending`, UI "Đang cắt" | tái hiện đúng bug gốc |
| đã có `c48d159` | `failed` sau vài giây | lớp 2 (`command-result`) ăn |

Nếu cloud đã deploy mà row vẫn `pending` quá 5 phút thì lớp 3 phải đóng
nó khi mở lại trang Video. Không đóng = lớp 3 hỏng, dừng lại điều tra.

## Ca B — nửa drain (phục hồi → phải gửi lại rồi xoá)

```bash
# terminal 1 — bật lại proxy ở chế độ pass hết
PASSTHROUGH=1 node scripts/fail-clip-result-proxy.mjs
```

```powershell
Restart-Service BetacomAgent
```

Drain chạy ngay lúc boot, không phải đợi 60s.

**Phải thấy:**

1. Log agent: `[clip-outbox] drain: gửi 1, bỏ 0, còn 0`
2. Log proxy: `POST /api/agent/clip-cut-result → 200`
3. File `pending-clip-results.jsonl` rỗng.

Row clip lúc này đã `failed` từ ca A rồi, nên callback muộn không đổi gì
thêm — đúng thiết kế (`clip-cut-result` guard `.eq(status,'pending')`),
không phải dấu hiệu hỏng.

## Nửa âm — bắt buộc chạy, đừng bỏ

Sau ca B, để nguyên proxy PASSTHROUGH (hoặc trả `BACKEND_URL` về thật),
bấm **Tạo lại** một clip nữa cho tới khi ra `ready`.

**Phải thấy:** `pending-clip-results.jsonl` **vẫn rỗng** và log không có
dòng `[clip-outbox]` nào. Luồng thành công mà vẫn xếp hàng = code mới
đang xếp bừa, hại hơn không có.

---

## Dọn sau khi kiểm

```powershell
Copy-Item 'C:\Program Files\BetacomAgent\.env.bak-truoc-ca-kiem' 'C:\Program Files\BetacomAgent\.env' -Force
Restart-Service BetacomAgent
```

Kiểm `BACKEND_URL` đã về `https://betabox.betacom.agency` rồi mới coi là
xong. Dừng proxy (Ctrl+C) và xác nhận cổng 8099 không còn ai nghe:

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen -ErrorAction SilentlyContinue
```

Row clip test của org demo có thể để lại (dữ liệu demo), hoặc xoá nếu
muốn sạch — nó không ảnh hưởng kho khách.

---

## Chỉ sau khi CẢ BA phần trên xanh mới cài 0.8.9 lên máy Đại Kim

Máy kho đang chạy ổn định sau khi pin `hosts`; không có lý do đụng vào
nó trước khi bản mới chứng minh được ở HN_01.
