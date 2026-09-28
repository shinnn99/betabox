# VẬN HÀNH NHIỀU KHO — tài liệu duy nhất

**Ngày:** 26/09/2026 · **Trạng thái:** Kế hoạch, chưa viết dòng mã nào

**Tài liệu này tự đủ.** Làm theo đúng nó, từ trên xuống, là đáp ứng được yêu cầu đã đề ra. Không cần mở tài liệu nào khác.

Mọi con số đều **đo trên hệ thống thật** ngày 25–26/09/2026. Phần suy ra cho nhiều kho ghi rõ là suy ra.

---

## Yêu cầu và chỗ đáp ứng

| Yêu cầu của chủ dự án | Đáp ứng ở |
|---|---|
| *"ngay khi thiết bị hoặc hệ thống của shop đó bị lỗi thì phải có thông báo chính xác về lỗi đó là lỗi gì về cho platform"* | Phần 1 (bật lại cảnh báo) · Phần 4 (sổ sự cố) · Phần 5 đợt 1, 3, 5, 7 |
| *"platform phải kiểm soát được toàn bộ các kho đang dùng hệ thống"* | Phần 4.6 (hai màn hình) · Phần 5 đợt 4, 7 |
| *"cần những hạ tầng gì nữa"* | Phần 2 |
| *"quản lý dễ hơn"* (cấu hình) | Phần 4.7 · Phần 5 đợt 2, 4, 6 |
| Làm sao biết đã xong | **Phần 6 — nghiệm thu** |

---

# PHẦN 0 — Sáu quyết định phải chốt trước

Mỗi câu đều có đề xuất. Đồng ý hết thì nhắn *"theo đề xuất"* là đủ, không cần trả lời từng câu.

| # | Quyết định | Đề xuất | Chặn đợt nào |
|---|---|---|---|
| 1 | Ổ đĩa máy kho (xem 1.4) — mua ổ 2 TB, hạ xuống 1080p, hay hạ hạn lưu? | **Cả hai việc đầu**: hạ 1080p ngay (0 đồng) + mua ổ 2 TB | Phần 1 |
| 2 | Khách có thấy sự cố kho mình không? | **Không, giai đoạn đầu.** Chỉ Betacom thấy. Mở cho khách sau khi câu chữ đã ổn định | đợt 4 |
| 3 | Mức nghiêm trọng báo bằng đường nào? | **Lark + email** qua healthchecks.io. Tin nhắn/điện thoại để sau, khi có người trực thật | đợt 1 |
| 4 | Ai trực, xem lúc nào? | Chốt **một người** + xem đầu giờ sáng mỗi ngày. Có sổ mà không ai nhận thì nó thành bảng không ai mở | đợt 3 |
| 5 | Ngưỡng "kho đang khoẻ" | agent ping < 5 phút; mọi camera đã khai báo có đoạn video trong 10 phút gần nhất; ổ còn > 7 ngày; hàng đợi clip < 20; lệch giờ < 5 giây | đợt 1 |
| 6 | Theo dõi egress/dung lượng Supabase bằng cách nào? | **Đặt cảnh báo chi tiêu ở cổng thanh toán Supabase** — rẻ nhất, không cần code | Phần 2.4 |

---

# PHẦN 1 — Làm ngay, không cần viết dòng mã nào

Bốn việc. Ba việc đầu **0 đồng**. Làm xong phần này là đã có cảnh báo chạy thật — phần lớn giá trị của cả tài liệu nằm ở đây.

## 1.1. Vì sao gấp: con tự kiểm đã chết 44 ngày

Đo trên `system_jobs`:

| Job nền | Số lần chạy | Gần nhất |
|---|---|---|
| `cleanup-clips` | 43 | 25/09/2026 ✅ |
| **`system-check`** | **7** | **13/08/2026** ❌ |
| **`orphan-segments`** | **0** | **chưa bao giờ** ❌ |

`system-check` là thứ chạy 10 phép kiểm tra và **gửi cảnh báo Lark**. Suốt 44 ngày, kho nào chết agent, mất camera, đầy ổ hay hỏng cron cũng không ai được báo.

Trang `/platform/system` vẫn xanh vì nó **tự chạy kiểm tra ngay lúc mở trang** — chỉ khi có người mở. Mã nguồn đã lường trước, ghi trong `src/app/api/system/status/route.ts`:

> *"Mốc 'con cảnh báo nền còn sống không' — thứ mà bản thân trang này không tự trả lời được: trang xanh nhưng timer chết thì vẫn mù."*

## 1.2. Bật lại cảnh báo — làm theo đúng thứ tự

### Bước 1 — Tạo webhook Lark cho nhóm IT (nếu chưa có)

Lark → nhóm IT Betacom → Settings → Bots → Add Bot → Custom Bot → đặt tên `Betabox Hạ tầng` → copy URL dạng `https://open.larksuite.com/open-apis/bot/v2/hook/xxxxx`.

> Tách khỏi webhook nghiệp vụ của khách có chủ đích: chuyện ổ đĩa, egress là nội bộ Betacom, khách không cần thấy.

### Bước 2 — Tạo hai check trên healthchecks.io

Đây là **dead-man switch** — thứ báo khi chính con cảnh báo chết. Thứ duy nhất báo lỗi cho anh/chị mà lại nằm trên chính cái máy có thể chết thì nó chết cùng cái máy đó. **Đúng chuyện đã xảy ra 44 ngày.**

| Check | Period | Grace |
|---|---|---|
| `betabox-syscheck` | 15 phút | 1 giờ |
| `betabox-orphan-segments` | 1 ngày | 2 giờ |

Mỗi check → Integrations → thêm **email của người trực**. Check đỏ mà không ai nhận thì dead-man cũng vô nghĩa.

Copy UUID trong URL ping `https://hc-ping.com/<UUID>`.

> **Không dùng lại UUID của `betabox-cleanup`.** Dùng chung thì cleanup ping mỗi ngày sẽ giữ check luôn xanh và che mất việc syscheck đã chết — đúng cái lỗ đang đi sửa.

Gói miễn phí đủ 20 check — thừa cho hàng chục kho, vì đây là check cho *job nền của Betacom*, không phải cho từng kho.

### Bước 3 — Nạp webhook vào app

```bash
ssh root@84.247.148.243
systemctl cat betabox | grep -i environment      # tìm file env của app
```

Thêm dòng vào file env đó:

```
LARK_INFRA_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/xxxxx
```

Rồi **kiểm biến đã vào tiến trình thật**, đừng tin là sửa file xong là xong:

```bash
systemctl restart betabox
sleep 5
tr '\0' '\n' < /proc/$(pgrep -f "next start" | head -1)/environ | grep LARK_INFRA
```

**ĐẠT khi** in ra đúng URL. Không in gì = app chưa thấy biến, dừng lại xử lý.

### Bước 4 — Cài hai timer

```bash
cd /home/betacom/app
git pull origin main

sed -i 's|THAY-BANG-UUID-SYSCHECK-MOI|<UUID-syscheck>|' docs/vps/betabox-syscheck.service
sed -i 's|THAY-BANG-UUID-ORPHAN-SEGMENTS-MOI|<UUID-orphan>|' docs/vps/betabox-orphan-segments.service

grep -n "hc-ping" docs/vps/*.service
```

**ĐẠT khi** không dòng nào còn chữ `THAY-BANG`.

> Đây là chỗ hay hỏng nhất: file trong repo vẫn còn chuỗi giữ chỗ. Cài nguyên vậy thì `curl` tới địa chỉ không tồn tại sẽ fail, và với `Type=oneshot` systemd đánh dấu **cả unit là failed** — timer coi như không chạy.

```bash
cp docs/vps/betabox-syscheck.service /etc/systemd/system/
cp docs/vps/betabox-syscheck.timer   /etc/systemd/system/
cp docs/vps/betabox-orphan-segments.service /etc/systemd/system/
cp docs/vps/betabox-orphan-segments.timer   /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now betabox-syscheck.timer
systemctl enable --now betabox-orphan-segments.timer
```

### Bước 5 — Chạy tay một lần và đọc kết quả

```bash
systemctl start betabox-syscheck.service
journalctl -u betabox-syscheck.service -n 30 --no-pager
```

### Bước 6 — Nghiệm thu

Chạy trên Supabase SQL Editor:

```sql
select job_name, ok, ran_at
from system_jobs
order by ran_at desc
limit 10;
```

**ĐẠT khi** có dòng `system-check` với `ran_at` trong vòng 15 phút vừa rồi. Chờ thêm 15 phút, chạy lại — phải có dòng mới. Nếu không có dòng nào mới: `systemctl list-timers | grep betabox` để xem timer có lên lịch không.

Trên healthchecks.io, hai check phải chuyển sang xanh.

## 1.3. Điền hạn lưu video hoàn hàng

`return_retention_days` của **cả hai tổ chức đều NULL**. Con số 7 ngày đang chạy là **mặc định trong mã nguồn**, không phải ai đặt. Hiện kết quả giống nhau nên chưa hỏng gì, nhưng muốn đổi thì phải điền vào ô đó — sửa mã nguồn là sai chỗ.

**Làm:** đăng nhập từng tổ chức → **Cấu hình kho** (`/dashboard/settings/warehouse-config`) → mục **1. Thời gian lưu video** → ô **"Số ngày giữ video hàng hoàn"** → điền **7** → Lưu.

**ĐẠT khi** ô đó không còn hiện chữ *"Để trống = 7 ngày"*.

## 1.4. ⚠ Ổ đĩa máy kho không đủ cho hạn lưu đang hứa

Vấn đề nghiêm trọng nhất tài liệu này, và nó **đã tồn tại ngay ở kho đầu tiên**.

| | |
|---|---|
| Camera toàn cảnh (CTC01) | **5,88 Mbps** |
| Camera QR (CQR01) | **2,73 Mbps** |
| Tổng | 8,61 Mbps = **3,87 GB/giờ** |
| Ca 8 tiếng | **≈ 31 GB/ngày** |
| **Hạn lưu đang đặt: 30 ngày** | cần **≈ 930 GB** |
| **Ổ máy kho** | **≈ 465 GB** (186 trống + 279 đã dùng) |

**Thiếu một nửa.** Bộ giữ ổ sẽ xoá dần để khỏi đầy — tức **hạn lưu thật ngắn hơn hạn lưu đã hứa với khách**, và không ai được báo điều đó.

### Việc a — Hạ camera toàn cảnh xuống 1080p (0 đồng, làm trước)

Giảm 31 → **≈ 21 GB/ngày**, đủ khoảng 22 ngày. Góc toàn cảnh chỉ cần thấy thao tác đóng gói; 4MP là phí ở cả ba mặt: ổ đĩa, băng thông, và độ trễ.

Giao diện web camera Hikvision → `Configuration → Video/Audio → Video`:

| Mục | Đặt thành |
|---|---|
| Stream Type | Main Stream (Normal) |
| Resolution | **1920×1080** |
| Bitrate Type | **Variable** (VBR) |
| Max. Bitrate | **4096 Kbps** |
| Video Encoding | **H.264** — giữ nguyên |

> **Không đổi sang H.265.** Máy kho chỉ coi H.264 là xem được thẳng trên trình duyệt; codec khác thì clip phải chuyển mã, đốt CPU máy kho.

**Đổi xong phải khởi động lại ghi hình**, ngoài giờ kho làm việc — máy kho đang sao chép nguyên luồng, đổi độ phân giải giữa chừng thì đoạn đang ghi có thể hỏng:

```powershell
Restart-Service BetacomAgent
Get-Service BetacomAgent
```

### Việc b — Đặt ổ 2 TB

Sau khi lắp, chuyển thư mục ghi và cập nhật `RECORDING_DIR` trong `.env` của agent, rồi `Restart-Service BetacomAgent`.

### Công thức báo giá kho mới

```
GB/ngày = (tổng Mbps của mọi camera) × 0,45 × (số giờ chạy mỗi ngày)
ổ cần   = GB/ngày × số ngày lưu × 1,3        (1,3 = dư địa cho bộ giữ ổ)
```

Kho 4 camera 1080p (≈3 Mbps/con), 10 giờ/ngày, lưu 30 ngày: `12 × 0,45 × 10 = 54 GB/ngày` → `54 × 30 × 1,3 ≈ 2,1 TB`.

**Kho từ 3 camera trở lên phải tính ổ 2–4 TB ngay từ lúc báo giá.**

## 1.5. Chốt và THỬ sao lưu database

Một dự án Supabase giữ **toàn bộ bằng chứng của mọi shop**. Mất nó là mất tất cả, không chỉ của một khách.

**Làm:** Supabase → Project Settings → Database → Backups. Ghi lại: gói đang dùng có **point-in-time recovery** không, giữ bao nhiêu ngày.

**Rồi thử phục hồi một lần** vào một dự án tạm. **Bản sao lưu chưa từng thử phục hồi thì chưa phải bản sao lưu.**

**ĐẠT khi** trả lời được: mất database lúc 10 giờ sáng thì phục hồi về được mốc nào, mất bao lâu, ai làm.

---

# PHẦN 2 — Hạ tầng

## 2.1. Đang có gì

| Lớp | Đang dùng |
|---|---|
| Ứng dụng web | **Một VPS**, Next.js chạy qua systemd; deploy bằng GitHub Actions → SSH → restart |
| Database + Auth + Storage | **Supabase**, một dự án cho mọi shop |
| Thông báo | **Lark webhook**, tách hai đường: hạ tầng (IT Betacom) và nghiệp vụ (khách) |
| Job nền | **systemd timer trên VPS** |
| Chống bot | Cloudflare Turnstile |
| Phát hành agent | GitHub + Git LFS (mỗi bản ~116 MB, gói miễn phí 1 GB) |
| Tại mỗi kho | Máy Windows + agent + MediaMTX + ffmpeg + camera IP + switch PoE |

## 2.2. Đồng hồ máy kho — hạ tầng, không phải chuyện nhỏ

Toàn bộ hệ thống cắt clip chạy theo **đồng hồ máy kho**: tên đoạn video đặt theo giờ máy, mốc quét lấy giờ máy, cửa sổ cắt tính theo giờ máy. Máy kho lệch 30 giây thì **mọi clip của kho đó lệch 30 giây**, và không có gì trên giao diện cho thấy điều đó.

Hệ thống *có* đo — agent gửi `time_drift_seconds` mỗi nhịp tim, lưu vào `warehouse_agents`. Cả hai agent đang báo **0 giây**. Nhưng **không phép kiểm nào cảnh báo khi nó lệch**. Đo mà không ai nhìn. → Vá ở đợt 1.

**Việc cần làm ngay:** bật NTP trên mọi máy kho, đưa vào quy trình cài máy.

## 2.3. Một VPS chạy cho tất cả

Một máy phục vụ mọi shop, không dự phòng.

**Tin tốt:** VPS chết thì máy kho **vẫn ghi hình bình thường** — agent ghi xuống ổ local, có hàng đợi gửi lại. Mất là mất giao diện, mất cắt clip theo yêu cầu, mất giám sát. **Không mất bằng chứng.**

Vì vậy **chưa đáng đầu tư dự phòng nóng hai máy**, trừ khi khách yêu cầu cam kết thời gian sống của giao diện. Nhưng phải theo dõi CPU/RAM/ổ VPS (phép kiểm `vps_resources` đã có, chạy được sau phần 1) và chốt: bao nhiêu kho thì tách máy.

## 2.4. Điểm mù về tiền: không đo được egress và dung lượng Supabase

Hai phép kiểm `supabase_egress` và `storage_usage` đều trả **"chưa đo được"**. Ghi chú trong mã nói rõ: Supabase không công khai API trả lượng dùng so với hạn mức, đã thử cả Management API lẫn Prometheus.

Một kho thì vào dashboard xem tay được. Nhiều kho thì **vượt hạn mức mới biết**.

**Đề xuất (quyết định #6):** đặt **cảnh báo chi tiêu** ở cổng thanh toán Supabase — rẻ nhất, không cần code, và tiền là thứ cuối cùng mọi vấn đề đều quy về.

## 2.5. Số dòng database tăng theo số kho

Đếm thật, một kho:

| Bảng | Số dòng | Suy ra 50 kho, mỗi tháng |
|---|---|---|
| **`agent_log_events`** | 32.029 (26.990 chỉ trong 7 ngày) | **≈ 5,8 triệu/tháng** |
| `camera_recording_files` | 34.275 | ≈ 1,4 triệu/tháng |
| `warehouse_scan_raw_events` | 4.293 | ≈ 200 nghìn/tháng |
| `packing_events` | 4.078 | ≈ 200 nghìn/tháng |
| `agent_commands` | 522 | nhỏ |
| `order_proof_clips` | 102 | nhỏ |

Hai bảng đầu chiếm gần hết, và `agent_log_events` **77% là nhiễu giải mã ffmpeg**. → Xử lý ở đợt 8.

## 2.6. Hạ tầng tại mỗi kho — đưa vào hợp đồng, không nói miệng

| Hạng mục | Yêu cầu | Vì sao |
|---|---|---|
| **Máy tính** | Windows, chạy 24/7, không ngủ, không tự khởi động lại | Agent chạy dịch vụ nền |
| **Ổ cứng** | Theo công thức 1.4 — kho 3+ camera là **2–4 TB** | Hạn lưu đã hứa phải chứa được thật |
| **UPS** | Bắt buộc | Mất điện đột ngột làm hỏng đoạn đang ghi và có thể hỏng chỉ mục |
| **Switch PoE** | Cổng **100 Mbps**; không bật chế độ Extend nếu cáp dưới 100m | Extend kéo cổng xuống 10 Mbps, đủ gây trễ camera |
| **Camera** | Hai con **cùng model**, cùng độ phân giải, cùng số khung hình, cùng H.264 | Khác model là clip hai góc lệch nhau, không sửa được bằng phần mềm |
| **Mạng** | Đường lên ổn định, IP nội bộ cố định cho camera | Đo ở Đại Kim: **198 KB/s** |
| **Đồng bộ giờ** | NTP bật, trỏ đúng máy chủ | 2.2 |

**Về đường lên 198 KB/s:** một camera ghi ra 1 GB/giờ, đường lên chở được 0,68 GB/giờ. **Đẩy nguyên video gốc lên cloud là không chạy được** với bất kỳ kho nào, trừ khi khách có đường truyền riêng.

---

# PHẦN 3 — Lỗi đang bị bỏ sót (hiện trạng)

## 3.1. Ba đường báo lỗi, mỗi đường thủng một kiểu

| Đường | Cơ chế | Thủng ở đâu |
|---|---|---|
| **Kiểm định kỳ** (10 phép) | 15 phút hỏi một lần | Timer chết 44 ngày, không tự báo cái chết của mình |
| **Log agent** | Bọc `console.warn`/`error` đẩy lên `agent_log_events` | **26.990 dòng / 7 ngày / MỘT kho**, 77% nhiễu. Không mã lỗi, không mức độ, không gom nhóm |
| **Lỗi lúc chạy ở cloud** | *(không có)* | Bỏ lượt quét thì **không ghi lại gì**, dù đã biết chính xác lý do |

## 3.2. Lỗi nặng bị chôn trong nhiễu

`agent_log_events`, 7 ngày, một kho:

| Nguồn phát | Số dòng |
|---|---|
| `[qr-frame-source]` (warn) | **20.948** — nhiễu giải mã ffmpeg |
| `[runtime-watchdog]` (warn) | 1.604 |
| `[camera-heal]` (warn) | 1.073 |
| `[segment-index]` (warn) | 857 |
| `[heartbeat]` (warn) | 600 |
| **`FATAL unhandledRejection` (error)** | **528** |
| **`MediaMTX exited` (error)** | **525** |
| `[segment-index]` (error) | 463 |
| **Tổng** | **26.990**, trong đó 1.592 mức error |

528 lần `FATAL` và 525 lần MediaMTX chết trong một tuần, **nằm im không ai được báo**.

## 3.3. Loại lỗi tệ nhất: biết lý do rồi vứt đi

Bắt được sáng 26/09: bàn đặt nguồn quét `camera`, có người quét bằng súng `MAY_QUET_01`. Route **biết chính xác** — tính ra cảnh báo `scan_source_disabled` kèm câu *"Nguồn quét này đang bị tắt trong cấu hình bàn"* và gửi cho agent. Nhưng cloud **không lưu lại**, nên nhật ký rơi vào nhánh mồ côi và gắn nhãn sai hai lần: *"Mã sai"* (mã hoàn toàn hợp lệ) và *"Đang chờ xử lý"* (sẽ không bao giờ được xử lý).

36 giờ trước đó: 5/90 lượt quét không sinh đơn, **cả 5 đều từ súng quét**. Lần này chưa mất đơn nào vì camera quét lại cùng mã — nhưng đơn nào **chỉ** quét bằng súng thì biến mất hoàn toàn: không đơn, không clip, không tính công.

## 3.4. Không biết máy kho đang chạy bản nào

Ngày 25/09, để xác nhận máy kho đã cài agent 0.12.0 chưa, phải nhờ chủ dự án gõ lệnh trên máy kho và **đọc kích thước file exe** — vì `remote-logger` chỉ chuyển tiếp `warn`/`error`, còn dòng nhận diện bản mới là `console.log`. Heartbeat hiện chỉ gửi `ping`, độ lệch giờ, nhịp watchdog.

Một kho thì phiền. Năm mươi kho thì không làm nổi.

## 3.5. Cấu hình cũng là điểm mù

| Đo cái gì | Kết quả |
|---|---|
| Hạn lưu video hoàn của hai tổ chức | **Cả hai NULL** — 7 ngày là mặc định trong mã |
| `max_order_seconds` kho Betacom Demo | Đặt **600**, tầng video kéo về **180** — **kẹp âm thầm** |
| Lệnh tạo tổ chức ghi cột nào | Chỉ `{name, slug}` — tổ chức mới ra đời chưa cấu hình |

Mười phép kiểm hiện có đều về vận hành; **không phép nào hỏi "kho này cấu hình đủ chưa, giá trị đặt có thật sự được dùng không"**.

## 3.6. Clip kiện hoàn bị cụt 2 phút cuối

Tìm ra khi làm đợt 2 (26/09/2026). `computeFinalizedClipWindow` cho clip kiện hoàn dài tới **310s** — ghi chú giải thích: *"cắt giữa chừng là mất giá trị khiếu nại"*. Nhưng ngay sau đó `clip-resolver.ts` áp một trần chung **180s cho mọi loại lượt**, đè lên trần riêng của kiện hoàn.

Đo trên production: kiện hoàn làm **300s** ra clip **đúng 180s**, lý do `capped_at_max_duration`. **2 phút cuối mỗi kiện hoàn 5 phút không có video bằng chứng.** Tab Cấu hình trên platform đã hiện chuyện này ở dòng *Thời gian tối đa một kiện hoàn*.

**Vì sao không nới trần ngay được:** clip hai góc được **ghép rồi nén lại** ở agent (`clip-composer.ts`) với bitrate cố định **3200 kbps**, bất kể camera ghi độ phân giải nào. Đo thật p95 3,16 Mbps → clip 310s ≈ **117 MiB**, vượt ngưỡng tải lên 90 MiB. Agent **từ chối** clip quá cỡ chứ không nén lại — nới trần ngay là biến *clip cụt* thành *không có clip*.

> Hạ camera xuống 1080p (1.4) **không** chữa được chuyện này — clip luôn nén lại ở cùng bitrate. 1080p chỉ chữa ổ đĩa và độ trễ.

**Cách sửa đúng, thứ tự bắt buộc — đưa vào đợt 7:**
1. **Agent**: bộ ghép tự hạ bitrate cho clip dài để vừa ngưỡng. Clip ngắn giữ nguyên 3200 kbps — đơn đi không đổi chất lượng.
2. **Cloud**: *sau khi* agent mới đã cài lên mọi máy kho, mới cho trần chung của `clip-resolver.ts` tôn trọng trần riêng 310s của kiện hoàn.

Làm ngược thứ tự thì agent cũ nhận cửa sổ 310s, ghép ra 117 MiB, từ chối tải lên — mất trắng.

## 3.7. Bốn thứ đang làm đúng — phải giữ khi mở rộng

- **Im lặng là bình thường.** `alert.ts` ghi rõ: bot chỉ nói khi có việc phải làm, vì *"nếu bot nói cả lúc khoẻ, người ta sẽ tắt thông báo, và lần thật sẽ không ai đọc"*.
- **Chống lặp 6 giờ** cho mỗi mục cùng trạng thái.
- **Tách webhook** hạ tầng khỏi webhook nghiệp vụ của khách.
- **Mỗi phép kiểm tự bọc lỗi thành `unknown`**, route không bao giờ 500 — *"một hệ theo dõi trả 500 là một hệ theo dõi cần người theo dõi nó"*.

---

# PHẦN 4 — Thiết kế

## 4.1. Agent KHAI BÁO trạng thái, cloud PHÁN XÉT

Quyết định quan trọng nhất của cả tài liệu.

| | Gửi sự kiện (hiện nay) | Khai báo trạng thái |
|---|---|---|
| Agent gửi gì | mỗi việc xảy ra một dòng chữ | một bảng trạng thái ngắn mỗi nhịp tim |
| Khối lượng | 26.990 dòng/tuần/kho → 50 kho = 1,35 triệu | **không đổi theo số việc xảy ra** |
| Ai quyết "đây là lỗi" | agent, lúc viết `console.warn` | **cloud**, biết org này mấy camera, ngưỡng bao nhiêu |
| Đổi ngưỡng cảnh báo | dựng bản agent mới, **đi cài từng máy** | sửa **một chỗ** trên cloud |
| Mất gói | mất luôn sự kiện đó | nhịp sau khai lại, **tự lành** |

**Agent không phải "kiểm soát lỗi" — nó chỉ khai sự thật về mình.**

Bản tự khai gửi kèm nhịp tim:

```
version, uptime, hệ điều hành, phiên bản ffmpeg
cameras: [{ mã, đang ghi?, đoạn cuối lúc nào, tỉ lệ khung hỏng }]
ổ đĩa:    { còn bao nhiêu GB, ước còn mấy ngày }
hàng đợi: { lượt quét chờ gửi, clip chờ cắt, clip chờ tải lên }
lần cuối đọc QR thành công
dấu vân tay cấu hình (.env đang dùng)
```

Ví dụ: org khai 2 camera mà bản tự khai chỉ có 1 đang ghi → cloud sinh sự cố `camera_not_recording`. Agent không cần tự biết điều đó là sai.

## 4.2. Lỗi im lặng bắt bằng VẮNG MẶT

**Agent không báo được cái chết của chính nó.** Mất điện, đứt mạng, Windows tự khởi động lại — không gói tin nào gửi đi. Mọi lỗi nặng nhất đều phải phát hiện bằng *thứ đáng lẽ phải tới mà không tới*.

Hệ thống đã làm đúng: `checkAgentHeartbeat` không đo "im lặng bao lâu" mà đo **số phút đóng gói đã trôi qua sau khi agent im** — tức lượng bằng chứng đã mất. Có `graceMinutes` nuốt chênh lệch lúc kho đóng cửa, đổi lấy việc không báo động giả mỗi tối.

## 4.3. Ngưỡng theo MẤT MÁT NGHIỆP VỤ

Hệ quả của 4.2: **kho một ca và kho ba ca không dùng chung con số "im lặng 30 phút"**. Ngưỡng phải quy về "bao nhiêu phút đóng gói không có bằng chứng", rồi mới suy ra mốc thời gian cho từng kho.

## 4.4. Gom theo `(shop, mã lỗi, đối tượng)` · Mã lỗi nào cũng phải có câu "cần làm"

Camera CQR01 rớt 300 lần trong đêm là **một** dòng `occurrence_count = 300`. Không có luật này thì sổ sự cố ngộp đúng như `agent_log_events` bây giờ, rồi bị tắt.

Và: **thêm mã lỗi mới mà không viết được câu "cần làm" thì không được thêm.** Trang hiện tại đã tách *triệu chứng* khỏi *việc cần làm*, với ghi chú: *"gộp cả hai vào một câu thì người trực phải tự suy ra bước tiếp theo"*.

## 4.5. Năm tầng lỗi và ai phát hiện được

| Tầng | Ví dụ | Ai phát hiện | Cách |
|---|---|---|---|
| **Thiết bị** | camera rớt, súng quét rút ra, ổ sắp đầy | **agent** | bản tự khai |
| **Kết nối** | mạng kho chết, agent không tới cloud | **cloud** | **vắng mặt** |
| **Chức năng** | ghi hình dừng, đọc QR không ra, cắt clip lỗi | **cả hai** | agent khai đang chạy gì; cloud xem kết quả lệnh |
| **Logic nghiệp vụ** | lượt quét bị bỏ, đơn 0 giây, kiện hoàn ma | **cloud** | ghi ngay lúc xảy ra |
| **Dữ liệu** | đoạn video thiếu giờ kết thúc, bản ghi mồ côi | **cloud** | quét định kỳ |

**Ba tầng dưới hoàn toàn ở cloud.** Agent chỉ gánh tầng trên cùng và nửa tầng chức năng — khoảng năm sáu mã lỗi.

## 4.6. Sổ sự cố và hai màn hình

**Bảng `warehouse_incidents`** — mỗi dòng là một sự cố, không phải một dòng log:

| Cột | Ý nghĩa |
|---|---|
| `organization_id`, `warehouse_id`, `agent_id` | Thuộc shop nào, kho nào, máy nào |
| `code` | `agent_offline`, `camera_down`, `scan_source_mismatch`, `mediamtx_crash`, `disk_low`, `clip_cut_failed`… |
| `severity` | `crit` / `warn` / `info` |
| `subject` | Mã camera, mã bàn, mã máy quét |
| `title`, `symptom`, `action` | Ba câu cho người trực |
| `first_seen_at`, `last_seen_at`, `occurrence_count` | Gom lặp |
| `status` | `open` / `acknowledged` / `resolved` |

**Ba đường đổ vào:** (a) 10 phép kiểm định kỳ — đổi từ gửi thẳng Lark sang ghi sổ trước; (b) bản tự khai của agent; (c) cloud ghi lỗi lúc chạy — lượt quét bị bỏ vì lệch nguồn, mã không đúng dáng, cắt clip thất bại, tải clip lên thất bại.

Kênh log thô vẫn giữ nhưng thành **kênh phụ**: có trần, lấy mẫu, hạn lưu. Nhiễu ffmpeg **không được là sự cố** — thành tỉ lệ *"CQR01: 3.000 khung hỏng/giờ"*, chỉ mở sự cố khi vượt ngưỡng.

**Trang Sự cố** — mọi kho, mặc định lọc `open`, `crit` trước. Mỗi dòng: shop, kho, mã lỗi, đối tượng, số lần, lần cuối, nút Ghi nhận / Đã xử lý.

**Trang Đội agent** — mỗi dòng một máy:

| Kho | Phiên bản | Ping cuối | Camera ghi | Ổ đĩa | Sự cố mở |
|---|---|---|---|---|---|
| Đại Kim | 0.12.1 | 1 phút | 2/2 | 6 ngày | 1 warn |
| … | 0.11.0 ⚠ | 3 ngày ❌ | 0/3 | — | 2 crit |

**Điều khiển từ xa** dùng lại `agent_commands` (đã ký HMAC, đã trả mã lỗi có cấu trúc): thêm `collect_diagnostics`, `restart_recording`, `resync_segments`. **Giới hạn:** lệnh chỉ chạy khi agent còn sống — agent chết thì vẫn phải có người tới kho.

**Chẩn đoán sâu theo event — chỉ chạy sau lỗi, không polling từ UI** (chốt 28/09/2026): người dùng bấm button → event chạy bình thường thì dừng ở đó; khi event mất phản hồi do timeout / mất mạng hoặc trả bất kỳ HTTP 4xx/5xx nào (gồm 422), cloud mới xếp `collect_diagnostics` cho **đúng agent** và mang theo `event_name`, đối tượng, thời điểm, correlation id. Agent thu trạng thái tập trung vào đối tượng đó rồi trả qua `command-result`; trang Đội agent của platform hiện “Xem quét sau lỗi”. Không mở trang platform để quét toàn hệ thống và không dùng interval trình duyệt làm nguồn sự cố.

Luồng này không thay thế phép canh **vắng mặt**: agent mất điện/chết hẳn thì không nhận được lệnh chẩn đoán, nên heartbeat/dead-man phía cloud vẫn là đường phát hiện duy nhất.

**Con cảnh báo phải tự báo cái chết của mình.** Ba lớp: (1) dead-man switch bên ngoài — **bắt buộc**; (2) sổ tự kiểm: không có lần chạy `system-check` nào trong 1 giờ → mở sự cố `monitor_stale`; (3) "lần tự kiểm nền gần nhất" là **ô đỏ to** trên trang, không phải dòng chữ nhỏ.

## 4.7. Cấu hình: ba tầng, một phép giải

```
mẫu nền tảng   →   giá trị tổ chức / kho   →   lan can kỹ thuật
(chỉ dùng lúc TẠO)  (sửa bất kỳ lúc nào)       (khoảng cho phép,
                                                 cũng đặt được)
```

Một hàm duy nhất giải ra **giá trị thực dùng** + **lý do** nếu khác giá trị đặt. Mọi nơi hiện cấu hình, mọi phép kiểm, mọi API đều gọi hàm này.

**Ở đâu hiện cấu hình cũng hiện hai cột:**

| Thông số | Đặt | Thực dùng | Vì sao khác |
|---|---|---|---|
| Hạn lưu video hoàn | — | 7 ngày | chưa đặt, đang dùng mặc định |
| Thời gian tối đa mỗi đơn | 600s | 180s | kẹp ở trần kỹ thuật của video |

Đây là **gốc của mọi vấn đề ở 3.5**: giao diện chỉ hiện một con số và người đọc đương nhiên tưởng đó là con số đang chạy.

**Mẫu nền tảng: chép lúc tạo, không phủ lúc đọc.** Nếu mẫu là tầng phủ lúc đọc thì sửa mẫu **âm thầm đổi cấu hình của mọi tổ chức chưa đặt**, kể cả kho đang chạy. Bù lại bằng nút "áp mẫu cho các tổ chức đang chọn" — hành động **có người bấm**, có audit.

**Lan can cho quyết định "cho đặt trần kỹ thuật":**
- **Trần clip nối thẳng với đường lên.** Nâng trần mà không nâng giới hạn tải lên = clip cắt xong **không lên được**. → Ô nhập phải hiện dung lượng ước tính.
- **Sàn bộ giữ ổ đĩa là phanh cuối.** Đặt xuống 1 ngày là tháo phanh. → Thêm phép kiểm: sàn thấp hơn hạn lưu của tổ chức là mâu thuẫn, hiện đỏ.
- **Đổi độ dài đoạn ghi không có tác dụng ngay** — file cũ vẫn 60s; phải khởi động lại ghi hình.

**Sửa trên platform — chốt về trách nhiệm.** Hai API `PATCH` sẵn có lấy `organization_id` **từ phiên đăng nhập của người dùng tenant**; gọi thẳng từ platform không được. Route platform riêng phải: lấy `organization_id` từ tham số đường dẫn; dùng lại đúng hàm validate của API tenant; **ghi audit với danh tính admin nền tảng**, không ghi thành "chủ tổ chức tự sửa".

---

# PHẦN 5 — Lộ trình

Cột **"anh/chị làm gì"** là phần cần người; còn lại tôi làm.

| Đợt | Việc | Anh/chị làm gì | Đụng agent? | Nghiệm thu |
|---|---|---|---|---|
| **0** | Phần 1 của tài liệu này | **Toàn bộ** | không | Xem 6.1 |
| **1** | Phép kiểm **Cấu hình**: thiếu giá trị bắt buộc, giá trị bị kẹp, cấu hình mâu thuẫn, **lệch giờ máy kho** | Chốt ngưỡng (quyết định #5) | không | Trang Tình trạng hiện đúng 2 mục đang thiếu cấu hình ở kho Đại Kim |
| **2** | Phép giải **Đặt / Thực dùng** (4.7) | — | không | Trang cấu hình hiện hai cột; `max_order_seconds` của Betacom Demo hiện "600 / 180 · kẹp ở trần" |
| **3** | Bảng `warehouse_incidents` + chuyển 10 phép kiểm sang ghi sổ | Chạy migration · chốt người trực (#4) | không | Tắt thử agent 10 phút → có dòng sự cố `agent_offline`, và Lark báo |
| **4** | **Trang Sự cố** + **bảng cấu hình toàn hệ thống, sửa được** | Duyệt giao diện | không | Sửa được hạn lưu của một org **từ platform**, audit ghi đúng tên admin nền tảng |
| **5** | Cloud ghi lỗi lúc chạy (4.6c) + sửa nhãn *"Nguồn quét bị tắt ở bàn này"* | — | không | Quét bằng súng ở bàn đặt camera → nhật ký hiện đúng lý do, không còn "Mã sai" |
| **6** | **Mẫu cấu hình nền tảng** sửa được + mở trần kỹ thuật thành cấu hình | Chốt bộ giá trị mẫu | không | Tạo tổ chức mới → tự có đủ cấu hình, không còn ô trống |
| **7** | **MỘT bản agent**: bản tự khai + nhận cấu hình từ cloud + lệnh chẩn đoán, kèm **trang Đội agent**. Kèm **sửa clip kiện hoàn bị cụt** (xem 3.6) — agent trước, cloud sau | Cài agent mới lên máy kho, **rồi mới** cho nới trần kiện hoàn | **có** | Trang Đội agent hiện đúng phiên bản, đúng số camera đang ghi, đúng ổ còn mấy ngày; kiện hoàn 300s ra clip phủ đủ 300s và **dưới 90 MiB** |
| **8** | Hạn lưu + gom nhiễu `agent_log_events`; định tuyến thông báo theo shop *(phần định tuyến TẠM HOÃN 26/09/2026 — chủ dự án: "lark tạm thời không động vào")* | — | không | `agent_log_events` một kho dưới 2.000 dòng/tuần |

**Đợt 0–6 không đụng agent một dòng nào.** Muốn cắt bớt thì bỏ đợt 7: platform vẫn biết mọi thứ cloud nhìn thấy được, chỉ là sự cố thiết bị vẫn phải đọc log thô.

**Thứ tự có lý do, đừng đảo:** đợt 2 là xương sống cho 4 và 6; đợt 3 phải có sổ trước thì 4 và 5 mới có chỗ đổ vào; đợt 7 làm phần "báo lên" **trước** phần "nhận xuống" — có báo lên mới nhìn được từ xa là máy kho đã nhận cấu hình mới chưa.

---

# PHẦN 6 — Nghiệm thu

## 6.1. Sau phần 1 (làm ngay)

- [ ] `select job_name, ok, ran_at from system_jobs order by ran_at desc limit 10` có dòng `system-check` **trong vòng 15 phút**, và có dòng mới sau mỗi 15 phút
- [ ] Hai check trên healthchecks.io **xanh**, có người nhận email
- [ ] Tắt thử timer 1 giờ → healthchecks.io **đỏ và gửi mail**
- [ ] Ô "Số ngày giữ video hàng hoàn" của cả hai tổ chức **đã điền**
- [ ] Camera toàn cảnh đã về 1080p, và `Get-Service BetacomAgent` đang chạy
- [ ] Trả lời được: mất database lúc 10 giờ sáng thì phục hồi về mốc nào, mất bao lâu, ai làm

## 6.2. Coi như đáp ứng yêu cầu khi

| Yêu cầu | Đạt khi |
|---|---|
| **Thông báo chính xác lỗi gì** | Gây lỗi thật ở kho (rút mạng camera) → trong 15 phút có **một dòng sự cố** nêu đúng camera nào, đúng lý do, kèm câu "cần làm"; và người trực nhận được tin |
| **Platform kiểm soát toàn bộ các kho** | Mở **một màn hình** thấy: mọi kho, kho nào có sự cố mở, kho nào chạy bản agent cũ, kho nào sắp hết ổ — **không phải đóng giả vào từng tổ chức** |
| **Không bị chôn trong nhiễu** | Số sự cố mở của một kho khoẻ là **0**. Không phải "ít", là 0 |
| **Không tự mù lần nữa** | Tắt con tự kiểm → trong 1 giờ có người nhận được báo, từ **bên ngoài** hệ thống |
| **Quản lý cấu hình dễ hơn** | Sửa hạn lưu của một org từ platform, không cần đóng giả; và nhìn ra ngay org nào đang chạy giá trị mặc định |

## 6.3. Dấu hiệu làm sai hướng

- Sổ sự cố có hơn 20 dòng mở cho một kho đang chạy bình thường → nhiễu lọt vào, quay lại 4.4
- Người trực bắt đầu bỏ qua tin Lark → đã phá nguyên tắc "im lặng là bình thường" ở 3.7
- Phải mở hai màn hình mới biết một kho khoẻ hay không → gộp lại
- Đổi một ngưỡng mà phải dựng bản agent mới → đã phá nguyên tắc 4.1

---

# PHẦN 7 — Rủi ro đã biết

| Rủi ro | Cách giảm |
|---|---|
| Sổ sự cố ngộp vì nhiễu rồi bị tắt, như mọi bảng cảnh báo bị ngộp | Gom theo `(shop, mã lỗi, đối tượng)`; nhiễu ffmpeg thành tỉ lệ; mã lỗi không có câu "cần làm" thì không được thêm |
| Ghi sổ ở đường chạy nóng làm chậm việc quét | Ghi sau khi đã trả lời agent (`after()`), không bao giờ chặn |
| `agent_log_events` phình theo số kho | Trần + hạn lưu + lấy mẫu, đợt 8 |
| Hai nguồn sự thật: trang tình trạng tự chạy kiểm, sổ thì do timer ghi | Trang đọc sổ là chính, chỉ chạy kiểm trực tiếp khi bấm làm mới |
| Bảng cấu hình tự gộp mặc định lần nữa ở tầng JavaScript | Đọc qua đúng `resolve_packing_timing` của database |
| Cài timer xong lại chết lần nữa mà không ai biết | Dead-man switch bên ngoài — bắt buộc, không phải tuỳ chọn |
| Bản tự khai thành cái cớ nhồi thêm việc vào agent | Giữ đúng ranh giới 4.1: agent **khai sự thật**, không phán xét |
| Sửa cấu hình từ platform nhưng audit ghi nhầm người | Route riêng, audit theo danh tính admin nền tảng |
| Nâng cấp agent sai một bản → tắt ghi hình của mọi khách cùng lúc | Nâng theo nhóm (một kho thử → vài kho → cả đàn), giữ đường lùi. **Chưa làm tự động cập nhật** |

---

## Tài liệu tham khảo thêm — không cần cho yêu cầu này

Hai tài liệu dưới đây là hướng dẫn cầm tay làm việc tại kho, dùng khi lắp hoặc chỉnh camera. Không cần đọc để thực hiện tài liệu này:

- `docs/camera-giam-do-tre-toan-canh.md` — năm bước chỉnh camera cho hết lệch clip giữa hai góc
- `docs/chon-2-camera-tranh-lech-clip.md` — tiêu chí chọn camera cho kho mới
