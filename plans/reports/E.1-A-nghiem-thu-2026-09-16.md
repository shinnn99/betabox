# Nghiệm thu Bước A — Định danh camera bằng MAC và tự dò lại IP

**Ngày:** 16/09/2026
**Kế hoạch:** [E.1 §2.4](../active/E.1-ip-camera-co-dinh-va-remote-live.md)
**Môi trường:** Supabase local (bản sao production), LAN thật 192.168.31.0/24, hai camera thật.

## Cách kiểm — vì sao không dùng mock

Next từ chối chạy dev server thứ hai trong cùng thư mục, nên thay vì dựng môi trường giả,
tôi gọi thẳng route handler thật trong một tiến trình Node với env trỏ vào Supabase local,
và dùng một HTTP server tí hon làm cầu nối cho phần agent. Chữ ký HMAC thật, route thật,
DB thật, camera thật. Không có lớp giả nào trong đường đi.

## 1. Lớp cloud — 10/10 mục

| # | Tình huống | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1 | Camera chưa có MAC báo về | Từ chối | Đạt |
| 2 | MAC báo về khác MAC trong DB | 409 `mac_mismatch` | Đạt |
| 3 | Chữ ký HMAC sai | 401 | Đạt |
| 4 | Agent báo cho camera của agent khác | Từ chối | Đạt |
| 5 | Agent báo cho camera khác tổ chức | Từ chối | Đạt |
| 6 | IP báo về nằm ngoài dải LAN riêng | Từ chối | Đạt |
| 7 | Hợp lệ | Đổi IP | Đạt |
| 8 | Hợp lệ | Tăng `ip_auto_healed_count` | Đạt |
| 9 | Hợp lệ | Ghi `ip_last_changed_at` + `camera_endpoint_history` | Đạt |
| 10 | Báo lại đúng IP đang có | `changed=false`, không ghi lịch sử rác | Đạt |

Mục 4 và 5 là hai chốt chặn quan trọng nhất: chúng chính là loại lỗi đã gây ra sự cố
Đại Kim (agent của kho này ghi đè thiết bị của kho kia).

## 2. Quét LAN thật

Quét 192.168.31.0/24: **4,7 giây**, lấy được MAC của 3/4 thiết bị sống.
MAC của cả hai camera đều đúng và khớp nhà sản xuất:

- Dahua `08:ED:ED:9F:DB:97`
- Hikvision `8C:22:D2:6C:7F:19`

Con số 4,7s đáng ghi lại: chú thích trong `camera-heal.ts` ban đầu tôi viết "vài chục giây"
theo cảm tính, đo xong đã sửa lại cho khớp thực tế.

## 3. Chuỗi đầy đủ

Dựng cạnh: ghi IP sai vào DB (192.168.31.250) → agent probe hỏng → quét lại subnet cũ →
khớp MAC → báo về cloud → DB đổi về 192.168.31.135. **Tổng 4,8 giây.**
Dữ liệu test đã trả lại nguyên trạng sau khi đo.

## 4. Chưa chứng minh được — cần agent thật

Ba nhánh dưới đây **chưa** nghiệm thu, và không nên coi là đã xong:

1. **Agent tự kích hoạt dò lại sau 3 nhịp probe hỏng thật.** Tôi dựng cạnh bằng cách ghi
   IP sai, chứ chưa để một camera thật rớt mạng 3 nhịp. Cần tạm dừng agent kho hoặc chờ
   giờ không có đơn.
2. **Lưu MAC khi thêm camera qua UI.** Code có, nhưng chưa bấm thật trên giao diện.
3. **Loại MAC của router trong mạng có định tuyến.** LAN test phẳng nên `dropAmbiguousMacs`
   chưa gặp tình huống nó sinh ra để xử lý.

Mục 2.4.1 của kế hoạch (đổi IP trên router, tự tìm lại trong ≤ 5 phút) vì thế mới đạt ở
mức chuỗi logic, chưa đạt ở mức tình huống thật.

---

## 5. Chạy thật trên agent kho — 16:24–16:30 ngày 16/09

Lần nghiệm thu ở trên dựng cạnh bằng cách gọi thẳng hàm. Lần này chạy
**tiến trình agent thật**, để nó tự phát hiện và tự xử lý.

**Cách dựng:** ngắt agent chạy code nhánh (giữ nguyên service production nên
ghi hình thật không mất phút nào), trỏ agent vào Supabase local, ghi IP sai
cho `hik_3` (192.168.31.250) trong khi camera vẫn ở 192.168.31.135.

### Kết quả

| Nhánh | Kỳ vọng | Kết quả |
|---|---|---|
| Đếm 3 nhịp probe hỏng **thật** rồi tự kích hoạt | Có | **Đạt** — log `[camera-heal] camera=hik_3 mất kết nối ở 192.168.31.250, quét lại 192.168.31.0/24 theo MAC 8C:22:D2:6C:7F:19` |
| Quét lại và tìm ra camera | Có | **KHÔNG ĐẠT** — `không thấy MAC ... camera có thể đã tắt` |

Camera lúc đó vẫn sống: ping 3 ms, bảng ARP có đúng `192.168.31.135 →
8c-22-d2-6c-7f-19`.

### Vì sao quét trượt

Hai lần quét cùng subnet, cách nhau vài giây, cùng máy:

| Thời điểm | Kết quả quét |
|---|---|
| Lúc heal chạy (agent vừa khởi động, đang bận) | `hosts_open=3 mac_resolved=2` |
| Chạy tay ngay sau đó | `hosts_open=7 mac_resolved=6` |

Quét cổng dùng timeout 1 giây và chạy trên chính máy đang ghi hình. Nó kém
tin cậy **đúng vào lúc cần nó nhất**, vì heal chỉ chạy khi máy đang bận
recording và đang retry ffmpeg cho camera hỏng. Lần nghiệm thu trước không
lộ ra vì lúc đó máy rảnh.

### Đã sửa

Đổi thứ tự tìm kiếm trong `camera-heal.ts`:

1. **Đọc bảng ARP trước** (`findIpByMac`) — đo thật: 47–60 ms, đúng cả hai
   camera, so với 4,7 s của một lần quét. Từ chối nếu MAC ứng nhiều IP.
2. Chưa thấy mới quét, và quét xong **tra ARP lần nữa** — quét chính là
   cách đánh thức ARP.
3. **Xác nhận cổng RTSP mở** ở IP mới trước khi báo cloud. Khớp MAC đã
   mạnh, nhưng một bản ghi ARP cũ có thể trỏ vào thiết bị đã tắt; báo nhầm
   là camera "online mà không có hình".

Sáu test mới khoá lại thứ tự này, trong đó có test chứng minh **không quét**
khi ARP đã trả lời, và test chặn báo cloud khi chưa xác nhận RTSP.

### Còn lại

Chuỗi đầy đủ **sau khi sửa** chưa chạy lại trên agent thật — máy đang được
dùng để test quét mã đơn. Cần một lần ngắt agent nữa để chốt.

Hai nhánh cũ vẫn chưa nghiệm thu: lưu MAC khi thêm camera qua UI, và loại
MAC router trong mạng có định tuyến.

---

## 6. Chạy lại sau khi sửa — 16:50–16:59

Cùng cách dựng như mục 5 (giữ service production chạy, ghi hình thật không
mất phút nào). Lần này lộ thêm **hai lỗi chặn đường**, cả hai đều chỉ thấy
được khi chạy tiến trình thật.

### Lỗi 1 — cloud từ chối trước khi kịp kiểm chữ ký

```
[camera-heal] cloud từ chối 401: {"error":"unauthenticated"}
```

`/api/agent/camera-ip-healed` không có trong `PUBLIC_API_PREFIXES` của
[proxy.ts](../../src/lib/supabase/proxy.ts), nên proxy phiên đăng nhập chặn
ngay vòng ngoài. Request **không bao giờ tới** chỗ kiểm HMAC.

Đây là lý do "10/10 mục đạt" ở mục 1 không phát hiện được: nghiệm thu đó gọi
thẳng route handler, bỏ qua toàn bộ lớp proxy. Một route agent có thể đúng
hoàn toàn về nội dung mà vẫn không dùng được.

Đã sửa, và thêm [test chốt](../../tests/agent-routes-bypass-proxy.test.ts)
đối chiếu toàn bộ `AGENT_API_PATHS` với danh sách bypass. Đã kiểm ngược:
xoá dòng khai báo ra thì test đổ đúng như mong đợi.

### Lỗi 2 — chữa được IP nhưng không ghi hình lại

Lần chạy thứ hai chữa IP thành công trong 40 giây, DB đúng hết. Nhưng sau
**120 giây** vẫn không có segment nào của `hik_3`.

Nguyên nhân là một thế tự khoá: phục hồi nhanh chỉ kích hoạt khi probe "ok"
2 nhịp liên tiếp, mà nhịp probe vẫn đang trỏ vào **URL cũ** — nó không bao
giờ ok được. Đường duy nhất biết URL mới là `longRetryAttempt`, chạy theo
nhịp **5 phút**.

Nói cách khác: hệ thống đã biết IP mới từ giây thứ 40, nhưng vẫn nằm im tới
5 phút mới ghi lại. Vẫn lọt tiêu chí "≤ 5 phút" của kế hoạch, nhưng là 5
phút mất bằng chứng không vì lý do gì.

Đã thêm `RecordingLifecycle.notifyEndpointHealed()` — chữa xong là lấy lại
credential và spawn ffmpeg ngay.

### Kết quả lần chạy thứ ba

**55 giây** kể từ khi agent khởi động, đủ cả chuỗi:

```
[camera-heal] camera=hik_3 mất kết nối ở 192.168.31.250, quét lại 192.168.31.0/24 theo MAC 8C:22:D2:6C:7F:19
[camera-heal] camera=hik_3 IP mới 192.168.31.250 → 192.168.31.135
[recording-lifecycle] IP vừa được chữa camera=hik_3, thử ghi lại ngay
[recording-lifecycle] long-retry refreshed credentials camera=hik_3 (rtsp_url changed)
[segment-index] rolled camera=hik_3 file=hik_3_20260916_165849.mp4
```

Đối chiếu:

| Kiểm | Kết quả |
|---|---|
| `cameras.ip` | 192.168.31.135 |
| `ip_auto_healed_count` | tăng |
| `ip_last_changed_at` | có mốc |
| `camera_endpoint_history` | 1 dòng, `source=auto_heal` |
| Tiến trình ffmpeg | đang đọc 192.168.31.135 |

**Mục 2.4.1 của kế hoạch: ĐẠT.** Mốc 55 giây này chạy với nhịp probe 10 giây
(rút ngắn để đỡ thời gian dừng); nhịp thật là 30 giây nên ngoài kho sẽ vào
khoảng 2 phút — vẫn trong hạn 5 phút.

### Vẫn chưa nghiệm thu

Mục 2.4.2 (cắm camera cùng model, không nhận nhầm) và lưu MAC khi thêm
camera qua UI. Cả hai cần thiết bị/thao tác thật, không dựng cạnh được.

---

## 7. Mục 2.4.2 — camera cùng model trên cùng subnet (17:05–17:10)

Chủ dự án cắm thêm camera. Trên LAN lúc này có **ba** thiết bị mở cổng RTSP:

| IP | MAC | Ghi chú |
|---|---|---|
| 192.168.31.12 | 08:ED:ED:9F:DB:97 | `dahua_3` |
| 192.168.31.18 | 38:77:07:5A:A2:07 | **camera cùng dòng firmware với hik_3** |
| 192.168.31.135 | 8C:22:D2:6C:7F:19 | `hik_3` |

`.18` và `.135` trả về header HTTP giống hệt nhau — đúng kịch bản "hai camera
cùng model, cùng subnet" mà mục 2.4.2 đặt ra.

### Phân biệt — 4/4 trên cả hai đường tìm kiếm

| Trường hợp | Kỳ vọng | ARP | Quét LAN |
|---|---|---|---|
| MAC của `hik_3` | .135 | Đạt | Đạt |
| MAC của camera cùng model | .18 | Đạt | Đạt |
| MAC của `dahua_3` | .12 | Đạt | Đạt |
| MAC bịa, lệch đúng 1 ký tự so với `hik_3` | không thấy | Đạt | Đạt |

Trường hợp cuối là trường hợp đáng lo nhất: camera cũ đã tắt hẳn, chỉ còn
camera cùng model bên cạnh. Hệ thống **không** vơ lấy nó, vì chỉ khớp MAC và
không bao giờ dùng vendor/model làm căn cứ phụ.

### Chạy đầu-cuối

Với cả ba camera đang sống, dựng lại cạnh IP sai cho `hik_3`: **55 giây**,
chọn đúng `.135`, ffmpeg xác nhận đang đọc `192.168.31.135` — không đụng
tới `.18`. DB: IP đúng, bộ đếm tăng, một dòng `camera_endpoint_history`
nguồn `auto_heal`.

**Mục 2.4.2: ĐẠT.**

### Ghi chú thêm: quét cổng lại bỏ sót

Lần quét ở mục này báo `hosts_open=4` và **không thấy `.18`**, trong khi quét
qua bảng ARP thấy đủ cả ba camera. Đây là lần thứ ba quan sát được cùng một
hiện tượng, củng cố quyết định ở mục 6: bảng ARP là đường tìm kiếm chính,
quét cổng chỉ là dự phòng.
