# RUNBOOK P0 — bật cảnh báo hạ tầng trước khi giao khách

Ngày viết: 09/09/2026. Chạy trên VPS `84.247.148.243` (betabox.betacom.agency).

**Vì sao có tài liệu này.** `system-check` chạy đúng 7 lần trong hai ngày
12–13/08/2026 rồi im 27 ngày. Trong khoảng im đó, ghi hình kho Đại Kim chết
từ 27/08 14:25 tới 04/09 15:39 — 8 ngày — và riêng ngày 28/08 kho đóng 79 đơn
mất sạch bằng chứng. Không ai được báo, vì nguyên tắc "im lặng là bình thường"
làm hệ giám sát chết trông y hệt hệ giám sát khoẻ.

Code phát hiện sự cố **đã có sẵn từ 13/08** (mục `recording_freshness`). Thứ
thiếu là timer chạy và đường gửi tin. Runbook này bật hai thứ đó.

**Nguyên tắc xuyên suốt: `systemctl status` KHÔNG phải bằng chứng.** Bằng chứng
là dòng mới trong bảng `system_jobs`. Mọi bước dưới đây verify bằng DB.

---

## Bước 0 — Chuẩn bị (làm trên máy bàn, ~10 phút)

### 0.1 Lark webhook cho nhóm IT

Cần một webhook **riêng**, không dùng chung với webhook nghiệp vụ gửi cho kho.
Lý do: tin hạ tầng (disk, egress, agent chết) là chuyện nội bộ Betacom.

1. Lark → nhóm IT Betacom → Settings → Bots → Add Bot → Custom Bot
2. Đặt tên `Betabox Hạ tầng`
3. Copy webhook URL dạng `https://open.larksuite.com/open-apis/bot/v2/hook/xxxxx`

### 0.2 Hai check trên healthchecks.io

Đây là dead-man switch — thứ báo khi **chính con cảnh báo** chết.

| Check | Period | Grace | Dùng cho |
|---|---|---|---|
| `betabox-syscheck` | 15 phút | 1 giờ | timer tự kiểm |
| `betabox-orphan-segments` | 1 ngày | 2 giờ | cron dọn segment mồ côi |

Với mỗi check, copy UUID trong URL ping (`https://hc-ping.com/<UUID>`).

**KHÔNG dùng lại UUID của `betabox-cleanup`.** Dùng chung thì cleanup ping mỗi
ngày sẽ giữ check luôn xanh và che mất việc syscheck đã chết — đúng cái lỗ
đang đi sửa.

Trong healthchecks.io, mỗi check → Integrations → thêm email hoặc Lark để
nhận báo khi check đỏ. Check đỏ mà không ai nhận thì dead-man cũng vô nghĩa.

---

## Bước 1 — Nạp biến môi trường

```bash
ssh root@84.247.148.243
```

Xem file env hiện có (đừng ghi đè — `CRON_SECRET` đang dùng cho cron dọn clip):

```bash
cat /etc/betabox-cron.env
```

Thêm webhook vào **env của app** (không phải file cron env):

```bash
grep -n "LARK_INFRA_WEBHOOK_URL" /etc/betabox/app.env || echo "CHUA CO"
```

> Đường dẫn env của app tuỳ cách deploy. Nếu app chạy bằng systemd service,
> tìm bằng `systemctl cat betabox | grep -i environment`. Nếu chạy bằng pm2/
> docker thì sửa ở chỗ tương ứng.

Thêm dòng:

```bash
LARK_INFRA_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/xxxxx
```

Restart app để nạp biến, rồi **verify biến đã vào tiến trình thật** — không tin
file đã sửa là biến đã có:

```bash
systemctl restart betabox
sleep 5
tr '\0' '\n' < /proc/$(pgrep -f "next start" | head -1)/environ | grep LARK_INFRA
```

PASS khi in ra đúng URL. Không in gì = app chưa thấy biến, dừng lại xử lý.

---

## Bước 2 — Cài unit systemd

Chép 4 file từ repo lên `/etc/systemd/system/`. Trước khi chép, **thay UUID**:

```bash
cd /root/beta_cam        # hoặc đường dẫn repo trên VPS
git pull

sed -i 's|THAY-BANG-UUID-SYSCHECK-MOI|<UUID-syscheck>|' \
  docs/vps/betabox-syscheck.service
sed -i 's|THAY-BANG-UUID-ORPHAN-SEGMENTS-MOI|<UUID-orphan>|' \
  docs/vps/betabox-orphan-segments.service

grep -n "hc-ping" docs/vps/*.service
```

PASS khi không dòng nào còn chữ `THAY-BANG`.

```bash
cp docs/vps/betabox-syscheck.service /etc/systemd/system/
cp docs/vps/betabox-syscheck.timer /etc/systemd/system/
cp docs/vps/betabox-orphan-segments.service /etc/systemd/system/
cp docs/vps/betabox-orphan-segments.timer /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now betabox-syscheck.timer
systemctl enable --now betabox-orphan-segments.timer
```

---

## Bước 3 — Chạy tay một lần, đọc kết quả thật

```bash
systemctl start betabox-syscheck.service
journalctl -u betabox-syscheck.service -n 30 --no-pager
```

Muốn xem đủ nội dung trả về:

```bash
source /etc/betabox-cron.env
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://betabox.betacom.agency/api/system/check | head -c 3000
```

Đọc `worst` và mảng `checks`. Lúc này nhiều khả năng thấy `recording_freshness`
và `agent_heartbeat` ở trạng thái `ok` hoặc `skipped` (nếu kho đang nghỉ).

---

## Bước 4 — VERIFY bằng DB, không bằng systemctl

Đây là bước quyết định. Chạy trên Supabase SQL Editor:

```sql
select job_name, ran_at, ok, duration_ms,
       detail->>'worst' as worst,
       detail->'alerted' as alerted,
       detail->'recovered' as recovered
from system_jobs
where job_name = 'system-check'
order by ran_at desc
limit 10;
```

**PASS khi:** có dòng mới trong vòng 15 phút gần nhất, `ok = true`.

Chờ 20 phút rồi chạy lại. **PASS khi số dòng tăng** — chứng minh timer tự chạy,
không phải chỉ lần bấm tay ở bước 3.

---

## Bước 5 — Gate 8 bài test

Chạy đủ 8, ghi PASS/FAIL từng bài. Không suy từ bài này sang bài khác.

### T1 — Timer tự sinh record liên tục

Chờ 45 phút sau bước 4, đếm lại:

```sql
select count(*) from system_jobs
where job_name = 'system-check' and ran_at > now() - interval '1 hour';
```

**PASS:** ≥ 3 dòng (15 phút/lần → 4 dòng/giờ, chấp nhận lệch 1).

### T2 — Reboot VPS xong timer tự trở lại

```bash
reboot
# đợi ~2 phút
ssh root@84.247.148.243
systemctl is-enabled betabox-syscheck.timer   # phải in "enabled"
```

Rồi đợi 20 phút, chạy lại query T1.

**PASS:** có dòng mới **sau** thời điểm reboot. Lấy mốc reboot bằng `uptime -s`.

> `Persistent=true` trong timer làm systemd chạy bù một lần ngay sau boot —
> nên dòng đầu tiên có thể tới sớm hơn 15 phút. Đó là hành vi đúng.

### T3 — Kill recording ⇒ alert trong ≤20 phút

Trên **máy kho Đại Kim** (không phải VPS), dừng ghi hình bằng đường tín hiệu
thật, không `taskkill /F`:

```powershell
nssm stop BetacomAgent
```

Rồi **phải có người quét vài đơn** ở kho — mục `recording_freshness` đo "kho
đóng gói bao lâu SAU segment cuối", không đo "segment cũ bao lâu". Không có
scan mới thì không có gì để đối chiếu và hệ im lặng **đúng**.

Đợi tới khi phút-đóng-gói-sau-segment-cuối vượt 10 (warn) rồi 20 (crit).

**PASS:** nhận tin Lark, và:

```sql
select ran_at, detail->'alerted'
from system_jobs
where job_name = 'system-check' and detail->'alerted' <> '[]'::jsonb
order by ran_at desc limit 3;
```

có `{"key": "recording_freshness", "status": "warn"}` rồi `"crit"`.

### T4 — Tắt camera ⇒ alert đúng camera

Rút mạng camera `dahua_01` (hoặc tắt nguồn). Agent vẫn chạy.

**PASS:** tin Lark nêu `camera_probe`, và nội dung tin có mã `dahua_01` —
không phải chỉ nói "1 camera lỗi".

> Ngưỡng `camera_probe` là 2 giờ lỗi liên tục (`failingMinutes: 120`), tính
> bằng `probe_consecutive_fails × 30s`. Muốn test nhanh hơn thì hạ tạm
> `CHECK_CONFIG.cameraProbe.failingMinutes` xuống 5, deploy, test, rồi trả lại
> — và ghi rõ trong biên bản test là đã hạ tạm.

### T5 — Kill system-check ⇒ dead-man alert trong ≤60 phút

```bash
systemctl stop betabox-syscheck.timer
```

**PASS:** healthchecks.io gửi báo "betabox-syscheck is DOWN" trong vòng 1 giờ
15 phút (period 15' + grace 60'). Bật lại:

```bash
systemctl start betabox-syscheck.timer
```

Đây là bài test quan trọng nhất trong 8 bài — nó là thứ duy nhất bắt được
đúng kiểu sự cố 12/08–09/09.

### T6 — Khôi phục camera ⇒ recording tự chạy lại

Cắm lại mạng camera / `nssm start BetacomAgent`.

**PASS:** trong ≤10 phút có segment mới:

```sql
select max(started_at) from camera_recording_files;
```

Long-retry của agent là 5 phút/lần nên chậm nhất ~5 phút.

### T7 — Recovery được ghi nhận

Sau T6, đợi lần chạy `system-check` kế tiếp.

**PASS:** nhận tin Lark tiêu đề **"[Betabox] Hạ tầng đã hồi phục"**, và:

```sql
select ran_at, detail->'recovered'
from system_jobs
where job_name = 'system-check' and detail->'recovered' <> '[]'::jsonb
order by ran_at desc limit 3;
```

có `["recording_freshness"]`.

**Nửa âm bắt buộc:** lần chạy TIẾP THEO nữa **không** được gửi lại tin hồi
phục (`recovered` rỗng). Gửi lặp = spam, và bộ test đã khoá luật này.

### T8 — Multi-tenant: alert ghi đúng tenant/kho/camera

Đọc nội dung một tin Lark bất kỳ từ T3/T4.

**PASS:** tin nêu đúng tên kho (`Betacom kho KĐT Đại Kim`) và đúng mã camera.

Bối cảnh: hiện có **2 org** trong DB, chỉ Đại Kim bật `monitoring_enabled`.
Org `Betacom` (id `...0001`) là môi trường dev, đã tắt theo dõi — đúng chủ ý,
vì agent demo `AGENT_KHO_HN_01` chạy trên máy dev từng làm mục heartbeat báo
crit giả ngày 12/08.

Kiểm cửa lọc còn đúng:

```sql
select id, name, monitoring_enabled from organizations;
```

**PASS:** đúng 1 org `monitoring_enabled = true`.

---

## Bảng ghi kết quả

| Bài | Nội dung | Kết quả | Bằng chứng |
|---|---|---|---|
| T1 | Timer tự sinh record | | |
| T2 | Reboot VPS | | |
| T3 | Kill recording ⇒ alert ≤20' | | |
| T4 | Tắt camera ⇒ alert đúng cam | | |
| T5 | Kill syscheck ⇒ dead-man ≤60' | | |
| T6 | Khôi phục camera ⇒ tự ghi lại | | |
| T7 | Recovery được ghi nhận | | |
| T8 | Alert đúng tenant/kho/camera | | |

**8/8 PASS → được mang sang khách.** Bài nào FAIL thì dừng, không "gần đúng".

---

## Cái runbook này KHÔNG bịt

Ghi ra để không ai tưởng đã phủ hết:

- **Disk máy kho** — agent chưa gửi dung lượng ổ trong heartbeat, cột chưa có.
  Mục `warehouse_disk` sẽ mãi `unknown`. Cần trước khách thứ 2, không phải
  khách đầu (Đại Kim ổ 465 GB, retention 30 ngày, 1 camera ~264 GB).
- **Egress + dung lượng Storage** — Supabase không có API trả mẫu số hạn mức.
  Vẫn phải xem tay ở dashboard. Đây là kết luận đã kiểm chứng, không phải bỏ sót.
- **Ghi hình khởi động muộn đầu ca** — cọc mở từ 14/08 (41 đơn mất bằng chứng
  ở Đại Kim 29–30/07). Sau khi bật cảnh báo, ca này sẽ **được báo** trong vòng
  10–20 phút thay vì không ai biết, nhưng nguyên nhân gốc chưa fix.
- **UPS cho máy kho** — mất điện đột ngột 5 lần trong 5 ngày (6–10/08). Đề xuất
  chưa làm.
