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

## Truy cập VPS và deploy (đọc trước mọi thứ khác)

Ghi 22/09/2026 sau một buổi mất cả tiếng vì tài liệu thiếu mấy dòng này.

| Mục | Giá trị |
|---|---|
| SSH | `ssh root@84.247.148.243` — cổng **22** mặc định |
| Thư mục app | **`/home/betacom/app`** |
| User sở hữu repo | **`betacom`** (KHÔNG phải root) |
| Nhánh deploy | **`main`** |
| Service | `betabox` → chạy `.next/standalone/server.js` |

Con số cạnh IP trong bảng điều khiển Contabo (`22290`) **không phải cổng SSH** —
đừng dùng nó để ssh.

**Chạy git/pnpm bằng user `betacom`, không bằng root.** Root thao tác vào repo
sẽ bị git chặn (`dubious ownership`); nếu bỏ qua cảnh báo đó bằng
`safe.directory` thì file build sinh ra thuộc root, service chạy dưới
`betacom` không đọc được và web gãy theo kiểu rất khó truy.

### Quy trình deploy

```bash
ssh root@84.247.148.243
su - betacom
cd /home/betacom/app

git status --short          # PHẢI trống. Có file lạ thì DỪNG, đừng pull đè.
git pull origin main
git log --oneline -1        # đối chiếu với commit mới nhất trên GitHub

pnpm install --frozen-lockfile
pnpm build

# HAI DÒNG NÀY BẮT BUỘC — xem giải thích bên dưới
cp -r .next/static .next/standalone/.next/
cp -r public .next/standalone/

exit                        # về root để restart service
systemctl restart betabox
systemctl status betabox --no-pager | head -15
curl -sS -o /dev/null -w "%{http_code}\n" https://betabox.betacom.agency/login
```

PASS khi `active (running)` và curl trả `200`.

**Dùng `pnpm`, KHÔNG dùng `npm`.** Repo có cả `package-lock.json` lẫn
`pnpm-lock.yaml`, nhưng `package-lock.json` chết từ 02/07/2026 — chỉ
`pnpm-lock.yaml` là thật.

**Vì sao hai dòng `cp`:** `next.config.ts` đặt `output: "standalone"`, và Next
KHÔNG tự chép `.next/static` với `public/` vào thư mục standalone. Thiếu thì
service vẫn lên `active (running)`, trang vẫn trả 200, nhưng mất sạch CSS/JS —
giao diện vỡ trắng, nhìn hệt lỗi code.

### Bẫy đã cắn thật: VPS theo nhầm nhánh

22/09/2026: merge vào `main` xong mà web không đổi. Nguyên nhân không phải quên
`git pull` — VPS đang ở nhánh **`feat/deploy-vps`**, nên tụt sau `main` **65
commit trong 40 ngày** (13/08 → 22/09) mà không ai biết.

Kiểm bằng `git log --oneline -1`: dòng đó phải ghi `HEAD -> main`. Nếu ra nhánh
khác:

```bash
git fetch origin
git checkout main || git checkout -b main origin/main
git pull origin main
```

**Merge vào `main` KHÔNG tự deploy.** Không có CI/CD; VPS chỉ đổi khi có người
chạy đúng quy trình trên. Nếu đã cài workflow `.github/workflows/deploy.yml`
thì push lên `main` sẽ tự chạy — kiểm ở tab Actions của GitHub.

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
cd /home/betacom/app     # repo nằm ở đây, KHÔNG phải /root/beta_cam
git pull origin main

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

### THỨ TỰ CHẠY — đọc trước khi bắt đầu

Ba bài đè lên nhau nếu chạy sai thứ tự. Cả ba đều làm bài bị đè **PASS giả**
hoặc không bao giờ kết luận được.

**1. T2 (reboot) phải chạy TRƯỚC T5 (dead-man).**
`betabox-syscheck.timer` có `Persistent=true` và đã `enable`, nên reboot sẽ bật
lại timer → syscheck chạy → ping healthchecks.io → **đồng hồ dead-man reset**.
Tắt timer rồi reboot thì T5 không bao giờ nổ.

**2. T5 phải chạy CUỐI CÙNG, sau khi T3–T8 xong hết.**
Trong lúc T5 đang đếm, timer đang tắt — không có lần chạy nào để sinh alert cho
T3/T4/T7. Mà nếu kích tay bằng `systemctl start betabox-syscheck.service` thì
`ExecStartPost` ping healthchecks.io và **reset dead-man**.

> Nếu buộc phải chạy syscheck trong lúc T5 đang đếm, dùng `curl` thẳng vào
> route — nó không đi qua `ExecStartPost` nên không ping dead-man:
> ```bash
> source /etc/betabox-cron.env
> curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
>   https://betabox.betacom.agency/api/system/check | head -c 2000
> ```
> Vẫn nên tránh: dễ quên mình đang ở chế độ nào.

**3. T5 không cần ngồi canh.** Khởi động rồi đi làm việc khác, kiểm hộp thư sau
1 giờ 15 phút. Đây là bài duy nhất chỉ tốn thời gian chờ.

Thứ tự đề nghị cho một buổi:

| Khi | Bài | Ghi chú |
|---|---|---|
| Đầu buổi | Bước 1–4 | Không test gì khác nếu bước 4 chưa PASS |
| +20 phút | **T1** | Timer tự sinh record |
| Ngay sau | **T2** | Reboot, xác nhận timer tự trở lại |
| Kho đang đóng hàng | **T3 → T6 → T7 → T8** | Chuỗi liền, cần có người quét đơn |
| Xen giữa | **T4** | Hạ tạm `failingMinutes`, nhớ trả lại |
| Cuối buổi | **T5** | Khởi động rồi đi; kiểm sau 1h15 |
| Sau T5 nổ | Bật lại timer | Xác nhận hệ về normal |

Lý do T3 → T6 → T7 đi liền: T3 phá ghi hình, T6 khôi phục, T7 đọc tin hồi phục
sinh ra từ chính lần khôi phục đó. Tách ra thì T7 không có gì để đọc.

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

Công thức: `scanned_at − ended_at − 3 phút (grace) > ngưỡng`. Nên:

| Muốn thấy | Chờ sau khi dừng agent, rồi mới quét đơn |
|---|---|
| warn (10 phút) | **> 13 phút** — dùng 15 cho chắc |
| crit (20 phút) | **> 23 phút** — dùng 25 cho chắc |

Vì phép so là giữa hai mốc TRONG DB, không so với đồng hồ hiện tại, nên cứ chờ
đủ rồi quét — không cần quét liên tục suốt khoảng đó.

Kiểm mốc thật trước khi kết luận:

```sql
select
  (select max(ended_at) from camera_recording_files where organization_id = '<org>') as segment_cuoi,
  (select max(scanned_at) from packing_events where organization_id = '<org>') as scan_cuoi;
```

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

---

## Checklist rời kho — 9/9 mới được về

Áp cho MỌI lần lắp đặt ở kho khách, kể cả khách thứ hai trở đi. Khác với gate 8
bài ở trên: gate 8 chứng minh **cơ chế cảnh báo sống**, checklist này chứng minh
**một kho cụ thể chạy được**. Làm gate 8 một lần; làm checklist này mỗi kho.

| # | Mục | Cách kiểm | Xong |
|---|---|---|---|
| 1 | Agent online | Dashboard hiện agent, hoặc `select code, now() - last_seen_at from warehouse_agents` < 1 phút | |
| 2 | Camera online | Dashboard hiện camera xanh | |
| 3 | Có segment mới | `select max(started_at) from camera_recording_files where organization_id = '<org>'` — trong 2 phút gần nhất | |
| 4 | Scan đơn tạo packing event | Quét thử một đơn, `select max(scanned_at) from packing_events where organization_id = '<org>'` | |
| 5 | Tìm được video theo đơn | Mở `/watch` cho đúng đơn vừa quét | |
| 6 | Cắt được clip | Bấm cắt, chờ tới `ready`, **mở xem được** | |
| 7 | `system-check` có record mới | `select max(ran_at) from system_jobs where job_name='system-check'` < 15 phút | |
| 8 | Test alert Lark thành công | Xem hướng dẫn riêng bên dưới | |
| 9 | Reboot máy, toàn hệ tự lên lại | Reboot máy kho, đợi 5 phút, kiểm lại mục 1–3 | |

**9/9 mới được rời kho.** Mục 6 phải **mở clip xem thật**, không dừng ở trạng
thái `ready` trong DB — `ready` chỉ nói file đã lên bucket, không nói nội dung
đúng.

Lấy `<org>` cho mục 3–4:

```sql
select id, name from organizations where monitoring_enabled = true;
```

Kho mới lắp phải được **bật `monitoring_enabled`** — nếu quên, mọi mục kiểm bỏ
qua kho đó và nó là điểm mù dù mọi thứ khác xanh:

```sql
update organizations set monitoring_enabled = true where id = '<org>';
```

Mục 9 dựa vào installer đã đặt service `SERVICE_AUTO_START` và
`AppExit Default Restart` (betacom-agent.iss:296,300) — agent tự lên sau reboot
và tự khởi động lại nếu chết. Vẫn phải kiểm bằng mắt, không tin cấu hình.

Trên máy kho, kiểm nhanh:

```powershell
Get-Service BetacomAgent | Select-Object Name, Status, StartType
```

`Status = Running`, `StartType = Automatic`.

Mục 8 là mục hay bị bỏ nhất vì mất thời gian nhất, và cũng là mục duy nhất
chứng minh kho này thật sự nằm trong tầm cảnh báo. Bỏ nó thì kho đó là điểm mù,
đúng như Đại Kim từng là điểm mù suốt 27 ngày.

### Cách chạy mục 8 mà không phải chờ 10 phút

Ngưỡng warn là 10 phút **đóng gói** trôi qua sau segment cuối — ở kho mới lắp,
đứng chờ đủ 10 phút rồi quét đơn liên tục là lãng phí.

Đường nhanh: dừng agent, rồi **quét đơn với thời điểm cách segment cuối > 10
phút**. Vì mục này so hai mốc trong DB (`packing_events.scanned_at` so với
`camera_recording_files.ended_at`), không so với đồng hồ hiện tại, nên chỉ cần
khoảng cách giữa hai mốc đủ lớn:

1. `nssm stop BetacomAgent` — ghi lại giờ, đây là mốc segment cuối
2. Chờ **15 phút** (làm mục khác trong checklist trong lúc chờ)
3. Quét 2–3 đơn thật ở trạm đóng gói
4. Kích syscheck: `curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" https://betabox.betacom.agency/api/system/check`
5. **PASS:** nhận tin Lark nêu `recording_freshness`, có tên kho đúng
6. `nssm start BetacomAgent`, chờ segment mới, kích syscheck lần nữa
7. **PASS:** nhận tin **"[Betabox] Hạ tầng đã hồi phục"**

Vì sao 15 phút chứ không phải 10: công thức là
`scanned_at − ended_at − graceMs > warnMs`, với `graceMs` = 3 phút và `warnMs`
= 10 phút (`CHECK_CONFIG.recording`). Cần khoảng cách **> 13 phút**; 15 là biên
an toàn. Muốn chạm mức crit thì chờ **> 23 phút** (20 + 3).

Bước 2 chạy song song với mục 1–7 của checklist, nên thực tế không tốn thêm
thời gian. Đừng rút ngắn bằng cách sửa ngưỡng ở kho khách — sửa xong quên trả
lại là để kho đó ngoài tầm cảnh báo.

> `scripts/verify-lark-notify.ts` KHÔNG dùng được cho mục này: nó test webhook
> **nghiệp vụ** gửi cho kho (`LARK_NOTIFY_ENABLED`), khác webhook **hạ tầng**
> (`LARK_INFRA_WEBHOOK_URL`) của hệ tự kiểm. Hai đường tách nhau có chủ đích.

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
