# E.1 — Tìm IP camera cố định + Xem camera từ xa (ngoài LAN)

**Trạng thái:** Bước A đang làm (tìm camera theo MAC); **Bước B tạm hoãn theo yêu cầu chủ dự án 16/09**
**Cập nhật:** 16/09/2026 — mã của Bước B đã rollback khỏi nhánh làm việc, cất ở nhánh `e1-backup-20260916` (commit bf78829)
**Liên quan:** thay thế/mở rộng `C.1.5-remote-live.md` (bản stub), dùng lại `B.1-agent-onvif-camera-connect.md`, `C.1.1-mediamtx-local-relay.md`

---

## 0. Kết luận trước, lý lẽ sau

| Bài toán | Phương án chốt | Chi phí hạ tầng tăng thêm |
|---|---|---|
| IP camera cố định | **Định danh theo MAC + ONVIF UUID, tự dò lại khi IP đổi.** Đặt IP tĩnh bằng **DHCP reservation trên router**, KHÔNG set tĩnh trong camera qua ONVIF ở bản đầu | 0 đ |
| Xem từ xa | **Agent đẩy main-stream lên VPS relay theo yêu cầu (on-demand), người xem lấy WebRTC từ VPS** | ~12–25 USD/tháng cho node relay đầu tiên; ~0,02 USD mỗi giờ-người-xem |

Ba quyết định đã chốt cùng anh (16/09): **chỉ admin/chủ kho nội bộ được xem**; **dùng main-stream để đọc được chữ trên phiếu**; **hệ thống sẽ đóng gói bán cho khách**, nên relay phải đa tenant và đo đếm được lưu lượng để tính tiền ngay từ bản đầu (xem §7).

Hai điều **không được làm**, vì đây chính là chỗ mất tiền lớn:

1. **Không NAT port / DDNS trỏ thẳng vào camera hoặc vào cổng 8889.** Hikvision/Dahua là nhóm thiết bị bị quét và khai thác nhiều nhất Internet; lộ ra là mất toàn bộ hình ảnh kho của khách, kèm rủi ro pháp lý vì đây là hệ thống lưu bằng chứng đóng hàng.
2. **Không stream 24/7 lên cloud.** Một camera 2 Mbps chạy liên tục là ~650 GB/tháng. 10 camera là 6,5 TB/tháng — tiền băng thông vượt xa toàn bộ giá trị tính năng. Chỉ đẩy khi có người thật sự đang xem.

---

## 1. Hiện trạng (đọc từ code, không phải giả định)

**Live hiện tại chỉ chạy được trên đúng máy bàn đóng hàng.** MediaMTX do agent sinh cấu hình bind chặt vào loopback — `rtspAddress: 127.0.0.1:8554`, `webrtcAddress: 127.0.0.1:8889`, `webrtcIPsFromInterfaces: false`, `webrtcAdditionalHosts: [127.0.0.1]` ([relay-hub.ts:66-80](../../warehouse-agent/src/live/relay-hub.ts#L66-L80)). Trình duyệt ở nơi khác không có đường nào tới. Đây là thiết kế cố ý và đúng, không phải thiếu sót.

**Cloud không đụng vào video live.** `buildWhepUrl` ghép URL từ `STATION_MEDIAMTX_WEBRTC_BASE_URL`, mặc định `127.0.0.1:8889` ([station-streams.ts](../../src/lib/live/station-streams.ts)). Cloud chạy trên Vercel (`vercel.json`) — không thể và không nên làm media server.

**Đã có sẵn 2 thứ rất quý, tiết kiệm nhiều công:**

- **Quét LAN đầy đủ**: [lan-discovery.ts](../../warehouse-agent/src/lan-discovery.ts) quét RFC1918, giới hạn /24, concurrency 64, port 554/80/8080/8000/8899 (+5000/37777 ở chế độ full), kèm WS-Discovery ONVIF, trả `confidence` và `suggested_rtsp_paths`. UI đã có ở `CamerasView.tsx` + `/api/cameras/discover`.
- **Sub-stream đã được mô hình hoá**: `cameras.rtsp_substream_path` có sẵn, `relayPathName(code, "sub")` đã sinh path riêng, pipeline QR đang dùng chính nhánh sub. Đẩy sub-stream đi xa là bước ngắn, không phải làm mới.

**Thứ đang thiếu, và là nguyên nhân sự cố mất kết nối:** không chỗ nào trong repo lưu **MAC address**. Toàn hệ thống định danh camera bằng IP. DHCP cấp lại IP là mất camera, không có cơ chế tự phục hồi.

---

## 2. Bài toán A — "IP cam cố định"

### 2.1 Đặt lại đề bài

"IP cố định" là phương tiện, không phải mục tiêu. Mục tiêu thật: **camera không bao giờ mất kết nối chỉ vì đổi IP, và khi đổi thì hệ thống tự tìm lại.** Cần 3 lớp, làm theo đúng thứ tự:

**Lớp 1 — Định danh bất biến (bắt buộc, làm trước).**
Camera được nhận dạng bằng **MAC address** (+ ONVIF UUID nếu có), không phải IP. IP tụt xuống thành "địa chỉ hiện tại", có thể thay đổi.

**Lớp 2 — Ghim IP bằng DHCP reservation trên router (khuyến nghị vận hành).**
Hệ thống hiển thị sẵn MAC + IP hiện tại và câu hướng dẫn để kỹ thuật viên đặt reservation trên router tại kho. Đây là cách an toàn nhất: sai thì sửa trên router, không mất quyền truy cập camera.

**Lớp 3 — Tự dò lại theo MAC khi mất kết nối (lưới an toàn).**
Probe hỏng N lần liên tiếp → agent tự quét subnet → khớp MAC → cập nhật IP mới → kết nối lại → ghi log và báo về cloud. Không cần con người.

### 2.2 Vì sao KHÔNG set IP tĩnh trong camera qua ONVIF ở bản đầu

ONVIF có `SetNetworkInterfaces`, làm được. Nhưng nhập sai gateway hoặc subnet mask là **mất camera ngay lập tức**, chỉ lấy lại được bằng cách ra tận nơi bấm nút reset và cấu hình lại từ đầu. Với kho ở xa, mỗi lần như vậy là một chuyến đi + thời gian chết của bằng chứng đóng hàng. Để ở pha sau, khi đã có: xác nhận hai bước, kiểm tra IP đích còn trống, và cơ chế tự rollback nếu sau 60 giây không ping lại được.

### 2.3 Thay đổi cụ thể

**Database** (migration mới, không sửa bảng cũ theo kiểu phá vỡ):

- `cameras.mac_address text` — chuẩn hoá `AA:BB:CC:DD:EE:FF`, unique theo `(organization_id, mac_address)`.
- `cameras.onvif_uuid text` — lấy từ WS-Discovery, dự phòng khi camera qua switch không lấy được MAC.
- `cameras.ip_last_changed_at timestamptz`, `cameras.ip_auto_healed_count int default 0` — để biết camera nào hay nhảy IP mà đi đặt reservation.
- Bảng `camera_endpoint_history (id, organization_id, camera_id, ip, mac_address, observed_at, source)` — lịch sử IP, phục vụ đối soát "clip này quay từ thiết bị nào".

**Agent:**

- `warehouse-agent/src/lan-arp.ts` (mới) — đọc MAC từ bảng ARP Windows (`arp -a`), có bước "chạm" trước (mở TCP 554) để ARP entry chắc chắn tồn tại. Chỉ chấp nhận MAC cùng subnet — thiết bị qua router sẽ trả MAC của router, phải loại bỏ, nếu không sẽ gán nhầm hai camera vào một MAC.
- `lan-discovery.ts` — thêm `mac_address` và `onvif_uuid` vào `DiscoveredDevice`.
- `camera-heal.ts` (mới) — khi `probe_consecutive_fails >= 3`: quét đúng subnet cũ → khớp MAC → báo cloud `camera.ip_healed` kèm IP mới. Agent **không tự ghi DB**, chỉ báo về; cloud mới là nơi ghi (giữ đúng mô hình hiện tại).

**Cloud:**

- `POST /api/agent/camera-ip-healed` — nhận IP mới từ agent, kiểm tra MAC khớp với `cameras.mac_address`, cập nhật IP + ghi `camera_endpoint_history` + `audit_logs`. **Bắt buộc khớp MAC** — không có MAC thì từ chối, tránh đúng kịch bản hôm nay: ghi đè nhầm camera của kho khác.
- Quét LAN trả thêm MAC; khi admin chọn thiết bị, MAC được lưu cùng lúc với IP.
- Backfill: với camera đang chạy, lần probe thành công kế tiếp gửi kèm MAC để điền dần, không cần nhập tay.

**UI** (`CamerasView.tsx`): hiện MAC dưới IP; badge "IP đã tự phục hồi N lần"; nút copy dòng hướng dẫn đặt DHCP reservation (MAC + IP đề xuất).

### 2.4 Nghiệm thu bài toán A

> **Đã chạy đầu-cuối trên agent thật 16/09/2026 — [báo cáo](../reports/E.1-A-nghiem-thu-2026-09-16.md).**
> **Mục 1, 2 và 3 đều ĐẠT.** Mục 1: 55 giây từ lúc agent khởi động tới khi có segment
> mới, gồm cả việc ghi hình tự chạy lại. Mục 2: nghiệm thu với camera cùng model thật
> trên cùng subnet (17:05–17:10), phân biệt đúng 4/4.
> Ba lỗi thật đã tìm ra và sửa trong quá trình này (quét trượt khi máy bận, route bị
> proxy chặn, ghi hình không tự chạy lại).

1. Đổi IP camera trên router (mô phỏng DHCP cấp lại) → trong vòng ≤ 5 phút hệ thống tự tìm lại, ghi hình tiếp, có dòng `audit_logs` `camera.ip_healed`.
2. Cắm thêm một camera khác cùng model, cùng subnet → không bị nhận nhầm là camera cũ (khớp MAC, không khớp model/IP).
3. Camera thuộc tổ chức A không bao giờ được cập nhật bởi agent của tổ chức B — có test.

**Ước lượng: 3–5 ngày công.**

---

## 3. Bài toán B — Xem camera từ xa

### 3.1 Năm phương án đã cân nhắc

| # | Phương án | Độ trễ | Chi phí/tháng | Rủi ro | Kết luận |
|---|---|---|---|---|---|
| A | NAT port + DDNS vào camera/MediaMTX | thấp | 0 đ | **Rất cao** — lộ camera ra Internet | **Loại** |
| B | Tailscale/ZeroTier overlay | thấp | 0–6 USD/người | Phải cài phần mềm trên **mọi máy người xem**; không dùng cho khách | Loại (chỉ hợp cho 2–3 kỹ thuật viên) |
| C | Cloudflare Tunnel + HLS | 2–6 s | 0 đ | Tunnel chỉ chuyển HTTP nên WebRTC không đi qua được, phải hạ xuống HLS; stream video trên gói free là vùng xám điều khoản | Dự phòng |
| D | WebRTC P2P + TURN dịch vụ | <0,5 s | 18–40 USD (Twilio ~0,4 USD/GB) | Nhà mạng VN phần lớn CGNAT nên gần như luôn phải relay qua TURN — trả tiền relay mà không được lợi ích tập trung | Loại |
| E | **Agent đẩy main-stream lên VPS relay theo yêu cầu** | **0,2–0,5 s** | **12–25 USD** | Thấp, kiểm soát được | **Chọn** |

Điểm quyết định giữa D và E: khi đã buộc phải relay (do CGNAT), thì relay đó nên là **máy của mình** — vì đó cũng là chỗ duy nhất áp được xác thực, hạn mức, ghi nhật ký ai đã xem camera nào. Với hệ thống lưu bằng chứng cho khách hàng, nhật ký xem là yêu cầu bắt buộc, không phải tuỳ chọn.

### 3.2 Kiến trúc chốt

```
[Camera] --RTSP LAN--> [MediaMTX trên máy bàn]  (giữ nguyên, vẫn 127.0.0.1)
                              |
                    ffmpeg -c copy (sub-stream)
                              |  SRT/TLS ra ngoài, chỉ khi có người xem
                              v
                       [VPS relay Singapore]
                       MediaMTX: nhận SRT, phát WHEP/WebRTC + LL-HLS dự phòng
                              ^
                        token ngắn hạn
                              |
[Trình duyệt admin ở bất kỳ đâu] <---- [Cloud Next.js: cấp quyền + ký token]
```

**Luồng một phiên xem:**

1. Admin bấm "Xem từ xa" → `POST /api/live/remote/{cameraId}/session`.
2. Cloud kiểm quyền (dùng lại `requireStationLiveAccess`), kiểm hạn mức, tạo `remote_view_sessions`, sinh `stream_key` dùng một lần (TTL 60 s) + `viewer_token` (JWT, TTL 5 phút).
3. Cloud đẩy lệnh `start_remote_publish` vào `agent_commands` — đúng hàng đợi đang dùng, có HMAC, có idempotency.
4. Agent nhận lệnh, spawn `ffmpeg -i rtsp://127.0.0.1:8554/<path-sub> -c copy -f mpegts srt://relay:8890?streamid=...` — **copy, không encode lại**, CPU gần như 0, dùng lại cơ chế `pidRegistry` + watchdog của `recording.ts`.
5. VPS MediaMTX gọi ngược về cloud (`authHTTPAddress` → `/api/media-auth`) để xác thực cả bên đẩy lẫn bên xem. VPS không giữ bí mật nào.
6. Trình duyệt WHEP tới VPS, xem trong ~0,3 s trễ.
7. Hết 10 phút, hoặc không còn người xem 30 giây, hoặc admin đóng tab → agent dừng ffmpeg, phiên đóng, ghi `audit_logs`.

**Dùng main-stream (anh đã chốt), và đây là cách giữ cho nó không đắt:**

Main-stream Hikvision 2688×1520 hiện ~4 Mbps, Dahua 1080p ~2 Mbps. So với sub-stream thì tốn gấp 4–8 lần, nên ba việc dưới đây là bắt buộc chứ không phải tuỳ chọn:

1. **Vẫn `-c copy`, tuyệt đối không transcode trên máy bàn.** Máy bàn kho là i5 hoặc yếu hơn — số đo thật đã có: re-encode clip 10 phút mất 16–20 phút. Máy đó đang vừa ghi 2 camera vừa giải mã QR; thêm transcode live là hỏng nghiệp vụ chính. Muốn giảm bitrate thì **chỉnh ngay trong camera** (Hikvision hạ main xuống 1080p ~3 Mbps vẫn đọc rõ chữ trên phiếu), không chỉnh bằng CPU.
2. **Mở luồng theo yêu cầu, đóng ngay khi hết xem.** Chi phí tỉ lệ thuận với số phút thật sự có người nhìn màn hình, không phải số camera lắp đặt.
3. **Bắt đầu bằng sub-stream, bấm "xem nét" mới chuyển sang main.** Người xem thường chỉ cần liếc xem bàn có ai không; lúc cần đọc phiếu mới bấm. Giữ mặc định ở sub cắt được phần lớn lưu lượng mà không lấy mất khả năng đọc chữ. Nút chuyển nằm ngay trên khung xem, đổi luồng trong ~2 giây.

Nếu anh muốn bỏ hẳn bước 3 và luôn mở main, chi phí vẫn nằm trong bảng §3.3 — chỉ là mất phần tiết kiệm dễ ăn nhất.

### 3.3 Chi phí — tính bằng số, không bằng cảm tính

Mốc tính ở **main-stream 4 Mbps** (trường hợp xấu nhất, Hikvision): 4 Mbps × 3600 s ÷ 8 = **1,8 GB / giờ-người-xem** mỗi chiều. Qua relay là vào 1,8 GB + ra 1,8 GB.

| Mức sử dụng | Lưu lượng ra ở VPS | Chi phí |
|---|---|---|
| 100 giờ-xem/tháng | 180 GB | trong gói 12 USD (1 TB) |
| 500 giờ-xem/tháng | 900 GB | vẫn trong gói 12 USD |
| 2.000 giờ-xem/tháng | 3,6 TB | 12 USD + ~26 USD vượt gói (0,01 USD/GB) |

VPS đề xuất: **Singapore, 2 vCPU / 4 GB, 1–2 TB transfer** (DigitalOcean/Vultr/Linode ~12 USD). Singapore vì RTT từ Việt Nam ~30–50 ms; đặt ở châu Âu rẻ hơn nhưng trễ ~250 ms, hỏng trải nghiệm. VPS chỉ chuyển tiếp gói tin, **không transcode**, nên nghẽn sẽ là card mạng chứ không phải CPU.

**Giá vốn cần nhớ khi định giá bán: ~0,018 USD (≈ 450 đ) cho mỗi giờ-người-xem ở main-stream.** Một khách xem 2 giờ/ngày, 30 ngày = 60 giờ = ~1,1 USD/tháng tiền băng thông. Đây là con số rất dễ chịu để gói vào gói thuê bao.

So sánh để thấy vì sao không chọn TURN dịch vụ: cùng 3,6 TB đó, Twilio TURN tính ~0,40 USD/GB = **1.440 USD/tháng**, so với ~38 USD của VPS riêng. Chênh lệch này là lý do chính để không dùng TURN thương mại khi đã biết chắc phải relay.

**Ba chốt chặn không cho chi phí vượt tầm kiểm soát** (phải làm ngay từ bản đầu, không để pha sau):

1. Tối đa **2 người xem đồng thời mỗi tổ chức**, tối đa **1 camera mỗi phiên**.
2. **Tự ngắt sau 10 phút**, và ngắt sau 30 giây không còn ai xem — chống bỏ quên tab mở qua đêm.
3. **Hạn mức giờ-xem/tháng cho mỗi tổ chức**, chạm 80% thì cảnh báo, chạm 100% thì chặn và báo admin.

Ràng buộc thứ tư nằm ở phía kho chứ không phải phía tiền: **2 luồng main-stream đồng thời là ~8 Mbps upload**. Đường truyền kho phải chịu được con số này trong lúc vẫn chạy nghiệp vụ khác. Xem §3.6.

### 3.6 Kiểm tra đường truyền trước khi bật cho một kho

Đây là bước bắt buộc trong quy trình lắp đặt, và cũng là tính năng bán được:

- Agent có lệnh `bandwidth_probe`: đẩy thử 4 Mbps lên relay trong 20 giây, đo throughput thật, jitter và tỉ lệ mất gói.
- Kết quả hiện ngay trong trang cấu hình kho: "Đường truyền đủ cho 2 luồng nét" / "Chỉ đủ 1 luồng" / "Không đủ, nên dùng sub-stream".
- Hạn mức số luồng đồng thời của kho **được đặt theo kết quả đo**, không để mặc định chung cho mọi kho.

Không có bước này thì khi bán cho khách có đường truyền yếu, triệu chứng sẽ là "xem giật" và khách đổ lỗi cho phần mềm, trong khi nguyên nhân nằm ở hợp đồng Internet của họ. Có số đo thì đó là một cuộc trao đổi khác hẳn.

### 3.4 Bảo mật

- VPS **chỉ mở** 8890/UDP (SRT) và 443 (WHEP/HLS qua TLS). MediaMTX trên VPS bật `authMethod: http`, mọi publish/read đều hỏi cloud.
- `stream_key` dùng một lần, TTL 60 giây, gắn cứng với `camera_id` + `session_id`.
- `viewer_token` JWT TTL 5 phút, tự gia hạn khi phiên còn sống; thu hồi được ngay bằng cách đóng phiên trong DB.
- Máy bàn **vẫn không mở cổng vào** — toàn bộ là kết nối đi ra, chạy tốt sau CGNAT.
- Credential camera **không bao giờ rời khỏi agent**, đúng như quy ước đang có trong `CLAUDE.md`.
- Mỗi phiên xem ghi `audit_logs`: ai, camera nào, kho nào, bao lâu. Đây là dữ liệu giám sát nơi làm việc của nhân viên — cần nhật ký, và nên có thông báo cho người lao động biết.

### 3.5 Nghiệm thu bài toán B

> **Chưa chạy được mục nào** — chưa có VPS thật. Hai hợp đồng kỹ thuật của MediaMTX
> đã kiểm chứng bằng bản chạy thật: [báo cáo](../reports/E.1-B-mediamtx-hop-dong-2026-09-16.md).

1. Admin ở mạng 4G ngoài kho xem được camera bàn 3, trễ đo được ≤ 1 s.
2. Rút mạng máy bàn giữa phiên → UI báo mất kết nối trong ≤ 10 s, phiên tự đóng, không còn ffmpeg treo.
3. Người dùng tổ chức A không mở được camera tổ chức B (test tự động, giống nhóm test đa tenant đang có).
4. Token hết hạn → luồng dừng, không xem lén tiếp được bằng URL cũ.
5. Đóng tab → trong 30 giây agent dừng đẩy; kiểm tra bằng đếm byte trên VPS.
6. Ghi hình bằng chứng **không bị ảnh hưởng** khi đang có người xem từ xa — đây là tiêu chí quan trọng nhất, vì ghi bằng chứng là nghiệp vụ chính, xem từ xa chỉ là tiện ích.

**Ước lượng: 8–12 ngày công + 1 ngày dựng VPS.**

---

## 4. Thứ tự triển khai

| Pha | Nội dung | Ngày công | Ra được gì |
|---|---|---|---|
| **1** | Bài toán A lớp 1+2: MAC, UUID, lịch sử endpoint, UI gợi ý DHCP reservation | 2–3 | Không còn mất camera vì đổi IP mà không ai biết |
| **2** | Bài toán A lớp 3: tự dò lại theo MAC | 1–2 | Tự phục hồi, hết loại sự cố như hôm nay |
| **3** | Dựng VPS relay + `relay_nodes` + `/api/media-auth` + hạn mức + công tắc theo tenant | 3–4 | Hạ tầng sẵn sàng, chưa mở cho người dùng |
| **4** | Agent publisher on-demand (`-c copy`) + lệnh start/stop + watchdog + `bandwidth_probe` | 4–5 | Xem được từ xa nội bộ, biết kho nào đủ đường truyền |
| **5** | UI "Xem từ xa" + nút chuyển sub/main + nhật ký + cảnh báo hạn mức | 2–3 | Mở cho admin chủ kho |
| **6** | Đo đếm lưu lượng theo tenant + báo cáo sử dụng | 2 | Định giá và xuất hoá đơn được |

Pha 1–2 độc lập hoàn toàn với pha 3–5, làm song song được và **nên làm trước**, vì nó sửa một lỗ hổng vận hành đang gây sự cố thật.

---

## 5. Rủi ro và cách chặn

| Rủi ro | Xác suất | Thiệt hại | Chặn bằng |
|---|---|---|---|
| Băng thông upload tại kho không đủ | Trung bình | Xem giật, ảnh hưởng cả ghi hình | Đo upload thật tại từng kho **trước** khi bật; dùng sub-stream; giới hạn 2 luồng |
| Nhà mạng chặn UDP/SRT | Thấp | Không xem được | Dự phòng RTMPS/443 — MediaMTX hỗ trợ sẵn |
| ffmpeg treo, VPS bị đẩy dữ liệu vô hạn | Trung bình | Cháy băng thông | Watchdog phía agent + hạn mức phía VPS + cron đóng phiên quá hạn |
| Gán nhầm MAC khi camera qua router | Thấp | Ghi đè nhầm camera | Chỉ chấp nhận MAC cùng subnet; bắt buộc khớp MAC mới cho cập nhật IP |
| Xem từ xa làm rớt ghi bằng chứng | Thấp | **Mất bằng chứng cho khách** | Publisher đọc từ MediaMTX local chứ không mở thêm kết nối tới camera; nghiệm thu bắt buộc mục 3.5.6 |
| VPS chết | Thấp | Mất tính năng xem từ xa | Ghi hình và cắt clip không phụ thuộc VPS — hỏng thì chỉ mất tiện ích, không mất nghiệp vụ |

---

## 6. Đóng gói bán cho khách — những gì phải làm ngay từ bản đầu

Vì hệ thống sẽ đem bán và scale theo từng khách, bốn thứ dưới đây **không được để pha sau**. Thêm sau khi đã có khách đang chạy thì phải migrate dữ liệu và đổi giá giữa chừng — luôn đắt hơn làm đúng từ đầu.

**1. Relay đa tenant ngay từ node đầu tiên.**
`remote_view_sessions` lưu `organization_id`, `camera_id`, `relay_node_id`, `bytes_in`, `bytes_out`, `started_at`, `ended_at`, `ended_reason`. Bảng `relay_nodes (id, region, hostname, capacity_mbps, status)` có từ đầu dù mới chạy một node — để sau này thêm node là thêm dòng, không phải sửa kiến trúc. Cloud chọn node lúc mở phiên và ghi vào phiên; agent nhận địa chỉ node trong lệnh chứ không đọc từ cấu hình cứng.

**2. Đo đếm lưu lượng theo tenant để tính tiền.**
MediaMTX trên relay ghi số byte mỗi phiên; cloud tổng hợp thành `org_usage_monthly`. Không có số này thì không biết khách nào đang ngốn băng thông, và không định giá được gói. Giá vốn đã tính ở §3.3: ~450 đ/giờ-người-xem.

**3. Hai mô hình triển khai, quyết định ngay vì ảnh hưởng thiết kế:**

| Mô hình | Mô tả | Hợp với |
|---|---|---|
| **Relay dùng chung** (mặc định) | Anh vận hành node, mọi khách dùng chung, tính tiền theo giờ-xem | Khách nhỏ và vừa, bán theo thuê bao |
| **Relay riêng của khách** | Khách tự có VPS, anh cài node lên đó | Khách lớn, khách yêu cầu dữ liệu không đi qua bên thứ ba |

Cả hai chạy cùng một mã nguồn node, chỉ khác dòng trong `relay_nodes` và ai trả tiền VPS. Thiết kế từ đầu cho cả hai thì gần như không tốn thêm công; chỉ làm mô hình đầu rồi sau này chữa thì phải bóc tách lại toàn bộ phần xác thực.

**4. Công tắc tắt theo tenant.**
Một khách vượt hạn mức, nợ phí, hoặc bị lạm dụng tài khoản thì phải tắt được riêng khách đó trong vài giây, không ảnh hưởng khách khác. Là một cột trong DB và một lần kiểm ở `/api/media-auth`, nhưng phải có từ đầu.

**Ước lượng phần đóng gói: thêm 3–4 ngày công** trên nền 8–12 ngày của §3.

---

## 7. Còn lại cần anh quyết

Ba câu đã chốt: chỉ admin nội bộ được xem; dùng main-stream; sẽ đóng gói bán. Còn bốn câu:

1. **Mặc định mở ở sub-stream rồi bấm "xem nét" để chuyển main, hay luôn mở thẳng main?** Tôi khuyến nghị cái đầu — tiết kiệm phần lớn băng thông mà vẫn đọc được chữ khi cần. Chỉ khác nhau một nút bấm ở phía người xem. — **Đã làm theo khuyến nghị:** UI mặc định "Nhẹ", có nút "Nét" chuyển sang main-stream. Đổi lại được nếu anh muốn khác.
2. **Duyệt VPS relay Singapore ~12 USD/tháng cho node đầu tiên?**
3. **Bán "xem từ xa" là tính năng kèm trong gói, hay gói cước riêng tính theo giờ-xem?** Ảnh hưởng tới việc có cần làm trang báo cáo sử dụng cho khách hay không.
4. **Có làm mô hình "relay riêng của khách" ngay không**, hay chỉ thiết kế sẵn chỗ và để dành khi có khách lớn đầu tiên?

Riêng phần A (MAC + tự phục hồi IP) không phụ thuộc câu nào ở trên — anh duyệt là tôi làm được ngay.

---

## 8. Tình trạng thực hiện (cập nhật 16/09/2026)

| Pha (§4) | Nội dung | Tình trạng |
|---|---|---|
| 1 | MAC, UUID, lịch sử endpoint, UI | Xong — migration `20260916120000_camera_mac_identity.sql` |
| 2 | Tự dò lại theo MAC | **Xong, đã nghiệm thu đầu-cuối** — 55 s gồm cả ghi hình chạy lại; [báo cáo](../reports/E.1-A-nghiem-thu-2026-09-16.md) |
| 3 | `relay_nodes` + `/api/media-auth` + hạn mức + công tắc tenant | **Tạm hoãn** — mã đã viết xong, cất ở `e1-backup-20260916` |
| 4 | Agent publisher on-demand + lệnh start/stop | **Tạm hoãn** — đã gỡ khỏi `warehouse-agent/src/index.ts` |
| 5 | UI "Xem từ xa" + nút sub/main + cảnh báo hạn mức | **Tạm hoãn** — đã gỡ khỏi trang Giám sát |
| 6 | Đo đếm lưu lượng theo tenant + báo cáo sử dụng | Bảng `remote_view_usage_monthly` đã có; **chưa có trang báo cáo cho khách** |

Ngoài kế hoạch gốc: [`infra/relay/`](../../infra/relay/README.md) — cấu hình MediaMTX,
script cài VPS và runbook, kèm [kiểm chứng hợp đồng kỹ thuật](../reports/E.1-B-mediamtx-hop-dong-2026-09-16.md).

### Còn phải làm trước khi tính năng dùng được thật

1. Thuê VPS Singapore, chạy `infra/relay/install.sh`, trỏ tên miền.
2. Thêm một dòng vào `relay_nodes` và bật `remote_view_enabled` cho tổ chức (mặc định TẮT).
3. **Lên lịch `/api/cron/sweep-remote-sessions` chạy mỗi phút** — chưa có thì phiên bỏ quên
   sống tới hết 10 phút. Cần anh xác nhận hệ thống chạy ở đâu để chọn `vercel.json` hay
   systemd timer.
4. Chạy nghiệm thu §3.5, đặc biệt mục 3.5.6 (ghi bằng chứng không bị ảnh hưởng).
5. Ba nhánh thực địa của Bước A — cần tạm dừng agent kho hoặc chờ giờ không có đơn.
6. Áp hai migration lên Supabase production (hiện mới áp ở local theo yêu cầu của anh).
