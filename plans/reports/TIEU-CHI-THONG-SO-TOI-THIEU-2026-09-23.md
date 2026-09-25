# Bộ tiêu chí thông số tối thiểu để hệ thống chạy mượt — 2026-09-23

> **Cập nhật 2026-09-25.** §2 (camera QR) đã viết lại: agent 0.11.0 bỏ mức ép cứng 640×360,
> giờ dò độ phân giải thật của camera và đọc ở đúng cỡ đó (trần 2560×1440), **và đọc thêm mã
> vạch một chiều** chứ không chỉ QR. Thêm tiêu chí **tiêu cự ống kính** vào §1 và §2 — mục này
> trước đây thiếu, mà nó quyết định mua đúng hay sai camera. Luật "nhiều mã trong khung" ở §2
> cũng đã tả lại cho khớp `code-pick.ts` (bản cũ tả sai thành "thấy 2 mã là bỏ cả hai").

Rà soát từ code thật (`warehouse-agent/src/`, `src/lib/camera/`), schema DB production và
**số đo bitrate thật của camera đang chạy** (bảng `camera_recording_files`, 7–30 ngày gần nhất).

Mọi con số dưới đây được suy từ giới hạn CÓ THẬT trong hệ, không phải khuyến nghị chung của
nhà sản xuất camera. Cột "Vì sao" chỉ ra chỗ trong hệ sẽ hỏng nếu không đạt.

---

## 0. Số đo thực tế — mốc để đối chiếu mọi ngưỡng bên dưới

Đo từ segment thật đã ghi (60 giây/file), không phải thông số ghi trên nhãn camera:

| Camera | Vai trò | MB / segment 60s | Bitrate thực | GB / camera-ngày (ghi 24h) | MB / giờ-ghi |
|---|---|---|---|---|---|
| CTC01 | Toàn cảnh | 41,7 | **5,83 Mbps** | 58,7 | 2.504 |
| hik_3 | Toàn cảnh | 20,5 | 2,87 Mbps | 28,9 | 1.296 |
| CQR01 | Quét QR | 19,0 | 2,66 Mbps | 26,8 | 1.143 |
| dahua_01 | Toàn cảnh | 15,0 | 2,09 Mbps | 21,1 | 899 |
| dahua_3 | Quét QR | 15,0 | 2,09 Mbps | 21,1 | 898 |

Hai điều đọc được từ bảng này, và đây là gốc của phần lớn tiêu chí bên dưới:

1. **Chênh lệch giữa camera cao nhất và thấp nhất là 2,8 lần** (5,83 vs 2,09 Mbps) dù cùng
   là camera toàn cảnh. Chênh lệch này không đến từ chất lượng hình mà từ cấu hình bitrate
   trong camera. Nghĩa là: **không chốt được dung lượng ổ nếu chưa chốt bitrate trong camera.**
2. Kho Đại Kim đã có tiền lệ bitrate **tự nhảy 5,3 lần trong 12 ngày** (170 → 900 MB/giờ-ghi,
   ghi trong `warehouse-agent/src/disk-guard.ts`). Cho nên bitrate phải bị **khoá cứng ở
   camera (CBR)**, không để camera tự điều chỉnh — xem §2.

---

## 0b. Loại camera — IP/PoE, tuyệt đối không USB

| Hạng mục | Kết luận | Căn cứ trong code |
|---|---|---|
| Loại camera | **Camera IP (LAN). Không hỗ trợ USB/webcam.** | Mọi đường vào đều là RTSP: ghi hình `-i rtsp://...` (`recording.ts:287`), giải mã mã vạch kéo từ relay `rtsp://127.0.0.1:8554/...` (`qr-frame-source.ts:114`). Repo **không có** `dshow`/`v4l2`/`avfoundation` ở bất kỳ đâu. Cắm webcam USB vào máy kho thì hệ không thấy nó: không UI khai báo, không preset, không đường ffmpeg. |
| PoE | **Khuyến nghị mạnh**, không phải ràng buộc phần mềm | Phần mềm chỉ cần RTSP tới được. PoE gộp nguồn + mạng vào một dây, bớt một điểm hỏng (adapter nguồn rời) và cấp nguồn tập trung qua UPS của switch. |
| Wi-Fi | **Cấm** | Mất gói → ffmpeg lỗi tạm → vào long-retry → ghi hình có lỗ. Xem §4. |
| Topology | Camera IP độc lập **hoặc** camera sau NVR | Preset RTSP có sẵn: Hikvision, Dahua, Imou, EZVIZ, chung `/ch1/main`, nhập tay (`rtsp-presets.ts:41-82`). Camera sau NVR phải lấy RTSP theo kênh từ IP của NVR. |
| Hãng nhận diện được khi quét LAN | Hikvision, Dahua, EZVIZ, Reolink, TP-Link, Uniview, Axis, Vivotek, Imou | `guessVendor()` (`probe.ts:82-95`). Hãng ngoài danh sách vẫn dùng được, chỉ là phải nhập RTSP tay. |

**Điểm cốt lõi về chuẩn video: hệ ghi y nguyên thứ camera phát ra.** Ghi hình dùng `-c:v copy`
(`recording.ts:291`) — không hề re-encode. Nên bitrate/độ phân giải/GOP đặt trong camera **là**
thứ nằm trên ổ cứng; hệ không chỉnh hộ được. Đây là lý do mọi tiêu chí dưới đây phải chốt
**trong camera**, không phải trong phần mềm.

| Chuẩn video | Hệ chấp nhận |
|---|---|
| Codec | **H.264 duy nhất** — xem §1 |
| Truyền tải | RTSP over **TCP** (mặc định; UDP có tuỳ chọn nhưng mất gói ở LAN kho) |
| Container ghi xuống ổ | MP4, mỗi segment **60 giây** (`-f segment -segment_format mp4`) |
| Audio | **Bị bỏ hoàn toàn** (`-an`) |

---

## 1. Camera TOÀN CẢNH (`role = proof_primary`)

Nhiệm vụ: quay bao quát bàn đóng hàng, là góc nền 1920×1080 của clip bằng chứng.

| Tiêu chí | Tối thiểu | Khuyến nghị | Vì sao — chỗ hỏng nếu không đạt |
|---|---|---|---|
| Codec | **H.264 (AVC)** | H.264 High Profile | `probeCodec()` gắn cờ `not_browser_safe` cho mọi codec ≠ h264 (`recording.ts:581`), banner cloud bật khi bất kỳ nguồn nào ≠ h264 (`codec-warnings/route.ts:42`). HEVC vẫn ghi được (ghi là `-c copy`) nhưng **clip không phát được trên `<video>`**, và nặng hơn: codec guard lúc cắt clip có thể làm **clip failed — không ra file bằng chứng nào** (`codec-invalidation.ts:3-5`). Tuyệt đối không H.265/HEVC. |
| **Tiêu cự ống kính** | **2.8mm** (góc ngang ~100°) | 2.8mm cố định | Ở độ cao lắp 2,2–2,5 m chếch 30–45°, ống 2.8mm mới phủ hết bàn đóng hàng rộng 1,2–1,5 m. Ống 4mm (~80°) ở cùng độ cao **cắt mất mép bàn**; từ 6mm trở lên chỉ thấy một phần tay. Không cần zoom/varifocal — góc đặt cố định. |
| Độ phân giải | **1280×720** | **1920×1080** | Clip compose về đúng 1920×1080 (`clip-composer.ts:143`). Dưới 720p thì `scale=...:increase` phóng to → mờ, nhìn không ra thao tác tay. Trên 1080p là phí: bị crop/scale về 1080p, chỉ tốn ổ và băng thông. |
| Khung hình | **15 fps** | **20–25 fps** | Dưới 15 fps thao tác tay bị "nhảy", mất khoảnh khắc đặt hàng vào thùng. Trên 25 fps không thêm giá trị pháp lý mà tăng dung lượng tuyến tính. |
| Bitrate | **2 Mbps** | **3–4 Mbps, CBR** | Đo thật: 2,09 Mbps đủ nhìn thao tác; 5,83 Mbps (CTC01) là **quá cao** — ngốn 58,7 GB/camera-ngày mà không hơn về nghiệp vụ. Ngưỡng trên phải ≤ 4 Mbps. |
| Kiểu bitrate | **CBR (cố định)** | CBR | VBR/"Smart codec"/H.264+ là nguyên nhân cú nhảy 5,3× ở Đại Kim. VBR làm mọi phép tính dung lượng ổ thành vô nghĩa. **Tắt Smart Codec / H.264+ / VBR.** |
| I-frame interval (GOP) | **≤ 2× fps** (VD 25 fps → GOP ≤ 50) | = fps (1 giây) | Clip cắt bằng `-c copy`, điểm cắt bám keyframe. GOP dài → clip bị lệch đầu/cuối tới vài giây, hoặc đầu clip xám. |
| Audio | **Tắt** | Tắt | Agent ghi với `-an` (`recording.ts:292`). Bật audio ở camera chỉ tốn băng thông LAN, không được ghi. |
| Sub-stream | **Có, ≤ 1 Mbps, ≤ 704×576** | 640×480 @ 512 kbps | Sub-stream là luồng mặc định cho xem-từ-xa (E.1 §3.2). Không có sub-stream → mọi lần xem live đi main-stream, tốn 4–8 lần băng thông upload. |
| Timestamp overlay (OSD) | **Tắt** | Tắt | Mốc thời gian lấy từ tên file + NTP máy kho, không lấy từ chữ đè trên hình. OSD sai giờ gây tranh chấp bằng chứng. |
| Góc đặt | Thấy trọn **mặt bàn + tay nhân viên + thùng hàng** | Cao 2,2–2,5 m, chếch 30–45° | Nếu không thấy tay thì clip không chứng minh được nội dung đóng gói — mất toàn bộ mục đích hệ thống. |

---

## 2. Camera QUÉT MÃ (`role = proof_qr`)

Nhiệm vụ: đọc mã vận đơn thay máy quét cầm tay, **và** làm ô PiP góc phải clip.
Đây là camera có tiêu chí NGẶT NHẤT vì nó phải giải mã được chữ, không chỉ nhìn được.

**Hai thay đổi lớn ở agent 0.11.0 (commit `2a57b63`, 24/09/2026) — đọc trước khi mua:**

1. **Hết ép cứng 640×360.** Bản cũ bóp mọi khung xuống 640 bề ngang trước khi giải mã, nên
   camera 2K cũng chỉ còn ~12 pixel cho một mã QR 12mm — không bộ giải mã nào đọc nổi (chính
   là ca nhãn TikTok đọc không ra). Giờ agent **ffprobe độ phân giải thật của luồng và giải mã
   ở đúng cỡ đó**, chỉ thu nhỏ khi vượt **trần 2560×1440** (`qr-frame-source.ts:19-23`, chỉnh
   bằng `QR_FRAME_WIDTH`/`QR_FRAME_HEIGHT`). Giải mã không phải chỗ tốn: đo thật 1920×1080 mất
   **17 ms**/khung, 2560×1440 mất **31 ms**/khung. Hệ quả mua sắm: **camera QR nét hơn giờ có
   giá trị thật**, khác hẳn kết luận cũ.
2. **Đọc cả mã vạch một chiều**, không chỉ QR: `Code128, Code39, Code93, ITF, Codabar` cộng
   `QRCode, MicroQRCode, rMQRCode, DataMatrix` (`qr-decoder.ts:71-72`). Nhãn vận đơn VN hầu hết
   là Code128. **Cố ý không mở EAN/UPC** — đó là mã sản phẩm in trên hộp, đọc trúng là tạo đơn
   sai. Mã vạch còn phải "trông giống mã vận đơn" (8–40 ký tự, ≥6 chữ số, không dấu cách) mới
   được xét, để không nhận nhầm mã tuyến kiểu `HN01` (`code-pick.ts:45-51`).

| Tiêu chí | Tối thiểu | Khuyến nghị | Vì sao — chỗ hỏng nếu không đạt |
|---|---|---|---|
| Codec | **H.264** | H.264 | Giống toàn cảnh, cộng thêm: MediaMTX relay + `QrFrameSource` chỉ tải luồng H.264 ổn định. |
| Loại mã đọc được | QR, MicroQR, rMQR, DataMatrix, **Code128, Code39, Code93, ITF, Codabar** | — | `qr-decoder.ts:71-72`. **Không** đọc EAN/UPC (mã sản phẩm trên hộp → tạo đơn sai). Nhãn VN phổ biến Code128. |
| **Chiều hình** | **Hình DỌC (portrait)** | Dọc, 9:16 | PiP crop về **360×640 đứng dọc** (`clip-composer.ts:153`). Ô ngang cũ 640×360 **cắt mất gần hết nhãn vận đơn** — đây là lỗi đã gặp và đã sửa. Camera phải tự xuất hình dọc; hệ **không xoay hình**. |
| **Tiêu cự ống kính** | **4mm** | 4mm (2.8mm nếu buộc phải đặt sát ~30 cm) | Khung phải HẸP, ngược hẳn camera toàn cảnh. Ở cự ly 40–50 cm, ống 4mm cho khung vừa đủ một nhãn — đúng thứ §"Vùng nhìn" bên dưới đòi. Ống góc rộng 2.8mm đặt xa sẽ ôm cả chồng nhãn chờ xử lý vào khung. Không dùng ống ≥6mm: khung quá hẹp, nhân viên phải giơ nhãn quá chính xác. |
| Độ phân giải | **1280×720** | **1920×1080; 2K (2560×1440) là mức tốt nhất có ích** | Agent giải mã ở **đúng độ phân giải camera**, trần 2560×1440 (`qr-frame-source.ts:19-23`). Nét hơn = mã nhỏ vẫn đủ pixel, đây là biến số quyết định đọc được mã QR nhỏ trên nhãn TikTok/Shopee. **Trên 2K là phí**: bị thu nhỏ về trần, chỉ tốn ổ và LAN. Dưới 720p thì mã nhỏ không đủ pixel mỗi ô vuông, bộ giải mã trượt. |
| Khung hình | **15 fps** | **25 fps** | Agent lấy mẫu **10 fps** (`QR_FRAME_RATE=10`) và cần **2 khung cùng một mã** mới xác nhận (`QR_CONFIRM_FRAMES=2`; bộ đếm reset khi khung cho ra mã khác — `qr-zone.ts:73-87`). Camera dưới 15 fps → không đủ khung trong lúc nhân viên giơ nhãn (~1 giây) → **quét im lặng, không ra đơn**. |
| Bitrate | **2 Mbps** | **2,5–3 Mbps, CBR** | Đo thật: CQR01 ở 2,66 Mbps đọc mã tốt. Dưới 2 Mbps, nén làm nhòe cạnh ô vuông QR → tỉ lệ đọc tụt. |
| Khoảng cách camera → nhãn | **30–60 cm** | 40–50 cm | Mã phải chiếm đủ pixel trên khung **ở độ phân giải thật của camera** (không còn bị hạ về 640×360). Với camera 1080p+ và mã QR 3×3 cm, 40–50 cm cho biên an toàn rộng; mã 12mm thì bám mép gần 30–40 cm. Xa hơn 60 cm là vùng rủi ro cho mã nhỏ. |
| Vùng nhìn | **Chỉ thấy 1 NHÃN tại một thời điểm** | Khung hẹp quanh vị trí giơ nhãn | Luật chọn mã (`code-pick.ts:77-104`): nhiều mã trong khung **không** tự động bị bỏ — nhãn vận đơn in mã LẶP LẠI (một mã vạch ngang, một QR, hai mã vạch dọc, cùng một số), nên **nội dung xuất hiện nhiều lần nhất thắng**. Chỉ khi hai nội dung KHÁC nhau mà bằng số lần và to xấp xỉ nhau (< 1,5×) mới trả `ambiguous` → `multiple_qr` và bỏ khung, vì đó là dấu hiệu **hai nhãn** cùng trong khung. Đặt camera thấy cả chồng nhãn chờ xử lý = liên tục ambiguous = tê liệt bàn. |
| Ánh sáng | **≥ 200 lux, không loá** | 300–500 lux, tán đều | Loá (đèn thẳng trên nhãn bóng) làm mất cạnh QR. Đây là nguyên nhân hỏng số 1 tại hiện trường, khó chẩn từ xa hơn cả lỗi mạng. |
| Chế độ hồng ngoại | **Tắt / ngày-đêm cố định ban ngày** | Tắt IR | Chuyển IR đổi độ tương phản đột ngột giữa ca → tỉ lệ đọc tụt bất thường mà không có lỗi nào trong log. |
| Sub-stream | **Có** (nếu dùng cho relay) | 640×480 | `relayPathName()` chọn sub khi có (`qr-scan-service.ts:160`). Thiếu sub → relay dùng main, nặng hơn cho cả LAN và CPU. |

---

## 3. Máy tính tại kho (Warehouse Agent)

| Tiêu chí | Tối thiểu | Khuyến nghị | Vì sao |
|---|---|---|---|
| OS | **Windows 10/11 x64** | Windows 11 Pro x64 | Agent đóng gói `.exe` + Windows Service + Task Scheduler. |
| CPU | **Intel i3 gen 8 / Ryzen 3, 4 luồng** | **i5 gen 10+, 6–8 luồng** | Ghi hình là `-c copy` (gần 0% CPU), nhưng **giải mã QR tốn thật**: mỗi camera QR = 1 ffmpeg decode 10 fps + 1 lần ZXing/frame. Cộng cắt clip `libx264 -preset veryfast`. Số đo thật: re-encode clip 10 phút mất **16–20 phút** trên i5 — tức máy yếu hơn i5 sẽ **tồn hàng đợi cắt clip**. |
| RAM | **8 GB** | **16 GB** | Mỗi camera ghi ~1 ffmpeg; cộng MediaMTX, agent Node, ffmpeg QR, ffmpeg cắt clip. 4 GB sẽ swap → watchdog bắt ffmpeg "treo" và kill-respawn vòng tròn. |
| Ổ ghi video | **500 GB, KHÔNG phải ổ C:** | **2 TB SSD/HDD 7200rpm riêng** | Tính từ đo thật, xem §5. Ổ C: đầy → Windows lỗi + ffmpeg cắt giữa file → **mp4 thiếu moov atom, không phát được** (đã xảy ra thật 13/07). |
| Loại ổ | HDD 7200 rpm nội bộ | SSD SATA/NVMe | **Không dùng ổ mạng SMB/NAS**: `disk-guard` và watchdog đã có ca readdir treo trên SMB → guard tê liệt ngầm. |
| Nguồn điện | **UPS ≥ 600VA** | UPS 1000VA + auto-shutdown | Mất điện đột ngột giữa segment → mp4 hỏng moov. Agent cần ~1,5 s flush khi shutdown sạch. |
| Đồng hồ hệ thống | **NTP bật, lệch ≤ 5 giây** | NTP time.google.com (installer tự set) | Mốc clip suy từ tên file theo giờ máy. Lệch giờ → banner đỏ "Agent lệch giờ", **clip cắt sai đoạn**. |
| Chế độ ngủ | **Tắt Sleep/Hibernate hoàn toàn** | Tắt cả Fast Startup | Máy ngủ = ngừng ghi im lặng. Tiền lệ: ghi hình Đại Kim **chết 8 ngày, 79 đơn mất bằng chứng**. |
| Windows Update | **Hoãn giờ hoạt động / restart ngoài ca** | Active hours phủ giờ kho | Reboot giữa ca mất ~2–5 phút ghi hình. Tiền lệ: ghi hình khởi động muộn 18 phút → **41 đơn mất bằng chứng**. |
| Antivirus | **Loại trừ thư mục recording + ffmpeg.exe** | Loại trừ cả thư mục cài agent | AV giữ handle file → `disk-guard` xoá thất bại (EBUSY) → báo "không đòi được chỗ" dù đã xoá. |

---

## 4. Mạng LAN tại kho

| Tiêu chí | Tối thiểu | Khuyến nghị | Vì sao |
|---|---|---|---|
| Camera → máy agent | **Dây LAN 100 Mbps** | **Gigabit, switch riêng cho camera** | **Tuyệt đối không Wi-Fi cho camera**: mất gói → ffmpeg báo lỗi tạm → vào long-retry, ghi hình có lỗ. |
| Máy agent | **Dây LAN** | Gigabit có dây | Agent dùng Wi-Fi = thêm một điểm rớt cho cả ghi hình lẫn báo cloud. |
| Băng thông LAN cần | **Σ bitrate camera × 2,2** | — | 2 camera × 3 Mbps = 6 Mbps ghi, cộng probe + relay QR + live. Với 6 camera × 4 Mbps = 24 Mbps → 100 Mbps vẫn dư, nhưng switch phải chịu được, không dùng hub. |
| Upload Internet | **5 Mbps** | **≥ 15 Mbps** | Upload clip bằng chứng (45–50 MB/clip, trần 90 MiB). Xem từ xa main-stream = **~4 Mbps/luồng**, tối đa 2 luồng đồng thời = **~8 Mbps** — đây là ràng buộc cứng phía kho. |
| Độ ổn định | Rớt < 1%/ngày | — | Mất mạng dài thì agent **vẫn ghi xuống ổ** và bù báo cáo khi mạng về (cửa sổ bù **30 ngày**). Mất mạng không mất bằng chứng, nhưng mất khả năng xem và cắt clip. |
| IP camera | **DHCP reservation hoặc IP tĩnh** | IP tĩnh + ghi sổ MAC | Camera đổi IP → agent tự chữa qua MAC/ONVIF nhưng **mất tối đa 5 phút** ghi hình. |
| Cổng camera | **RTSP 554 mở tới máy agent** | + ONVIF 80/8000 cho auto-discovery | Firewall camera chặn 554 là lỗi đã gặp: "ping được nhưng không kết nối RTSP" (báo cáo 14/09, camera Dahua). |
| Port cục bộ máy agent | **8554, 8889, 8189 (localhost) rảnh** | — | MediaMTX bind 127.0.0.1:8554 (RTSP), :8889 (WebRTC), :8189. Bị chiếm → relay không start → QR không đọc, live không xem. |

---

## 5. Dung lượng ổ — công thức, không phải con số cứng

```
GB cần = Σ(bitrate_camera_Mbps) × 3600 × giờ_ghi_mỗi_ngày × số_ngày_lưu ÷ 8 ÷ 1024
         × 1,25   ← biên cho disk-guard (sàn 7 ngày + ngưỡng dừng 48 giờ-ghi)
```

Bảng tra sẵn, tính ở **3 Mbps/camera** (khuyến nghị), ghi **10 giờ/ngày**:

| Số camera | Lưu 30 ngày | Lưu 45 ngày | Lưu 60 ngày |
|---|---|---|---|
| 2 (1 bàn: toàn cảnh + QR) | ~500 GB | ~740 GB | ~990 GB |
| 4 (2 bàn) | ~990 GB | **~1,5 TB** | ~2,0 TB |
| 6 (3 bàn) | ~1,5 TB | ~2,2 TB | ~3,0 TB |

Nếu camera để **5,83 Mbps như CTC01 hiện tại**, mọi số trên **×1,9**. Đây là lý do §2 đặt
trần bitrate ≤ 4 Mbps — nó là tiêu chí tiết kiệm ổ, không phải tiêu chí chất lượng.

Ngưỡng tự động đã cài trong `disk-guard`:
- Cảnh báo khi còn **< 48 giờ-ghi** trống.
- Tự xoá segment cũ nhất khi còn **< 12 giờ-ghi**.
- **Không bao giờ xoá segment trẻ hơn 7 ngày** (sàn cứng, không có env override).
- Chạm sàn mà vẫn thiếu chỗ → dừng + báo động. Đây là lỗi **phần cứng**, chỉnh ngưỡng không cứu được.

Ngưỡng tính bằng **giờ-ghi**, không bằng phần trăm ổ — nên ổ càng nhỏ, ngưỡng càng sớm kích hoạt,
tự hiệu chỉnh khi thêm camera hoặc camera đổi bitrate.

---

## 6. Checklist nghiệm thu tại kho — làm theo thứ tự, mỗi mục một bằng chứng

Không mục nào được suy ra từ mục khác; mỗi mục phải có kết quả quan sát riêng.

**A. Trước khi rời kho**
1. `ffprobe` từ chính máy agent ra `codec_name=h264` cho **từng** camera.
2. Dashboard → Cameras: **không** camera nào có cờ `codec_warning`.
3. VLC trên máy agent mở được cả main-stream và sub-stream của từng camera.
4. Camera QR: giơ nhãn thật → chạy `test_qr_decode` → **đọc đúng mã trong 10 giây**.
5. Camera QR: giơ **2 nhãn cùng lúc** → hệ phải **không** tạo đơn (kiểm cảnh báo `multiple_qr`).
6. Đóng 1 đơn thật → xem clip: **nền 1920×1080 rõ tay nhân viên**, **ô PiP dọc đọc được nhãn**.
7. `w32tm /query /status`: lệch giờ ≤ 5 giây.
8. `--disk-guard-dry-run`: đối chiếu `MB/giờ-ghi` đo được với §5; xác nhận `chạm sàn = không`.
9. Services.msc: `BetacomAgent` = Running, Startup = Automatic.
10. Task Scheduler: `BetacomAgentCleanup` có lịch, và **retention đã cấu hình trên dashboard**
    (chưa cấu hình → cleanup **không chạy**, cố ý fail-loud → ổ đầy dần).
11. Sleep/Hibernate đã tắt: `powercfg /a` xác nhận.
12. Rút dây mạng WAN 5 phút → cắm lại: agent phải tự báo lại, **segment trong 5 phút đó vẫn có trên ổ**.

**B. Sau 24 giờ — đối chiếu số, không chỉ nhìn xanh**
13. Số segment thực tế ≈ (giờ ghi × 60) mỗi camera. Thiếu nhiều = có lỗ ghi hình.
14. `MB/giờ-ghi` từ `disk-guard` ổn định, không nhảy > 1,5× so với ngày đầu.
15. Số đơn quét bằng camera QR **khớp** số đơn thực đóng trong ngày.
16. Log agent không có `killed_by_registry_trust`, không có chuỗi kill-respawn lặp.

---

## 7. Ba thứ hay bị bỏ qua nhất, và đều đã gây mất bằng chứng thật

1. **VBR / Smart Codec bật trong camera** — Đại Kim nhảy 5,3× dung lượng trong 12 ngày.
   Bắt buộc CBR.
2. **Camera QR đặt hình ngang** — PiP crop 360×640 dọc sẽ cắt mất gần hết nhãn vận đơn.
   Phải đặt camera xuất hình dọc; hệ không xoay hộ.
3. **Máy kho để Sleep hoặc Windows Update tự restart** — hai tiền lệ: chết ghi hình 8 ngày
   (79 đơn) và khởi động muộn 18 phút (41 đơn). Cả hai đều **không** có báo lỗi ồn ào tại chỗ.

---

## 8. Tóm tắt mua sắm — chốt trước khi đặt hàng

| | Camera TOÀN CẢNH | Camera QUÉT MÃ |
|---|---|---|
| Loại | IP/PoE (không USB) | IP/PoE (không USB) |
| **Tiêu cự** | **2.8mm** | **4mm** |
| Độ phân giải | 1080p | **1080p–2K**, 2K là mức tốt nhất còn có ích |
| Chiều hình | Ngang 16:9 | **DỌC 9:16 (portrait/corridor mode)** |
| Codec | H.264 | H.264 |
| fps | 20–25 | 25 |
| Bitrate | 3–4 Mbps **CBR** | 2,5–3 Mbps **CBR** |
| Hồng ngoại | theo nhu cầu | **Tắt** |
| Lắp đặt | cao 2,2–2,5 m, chếch 30–45° | cách nhãn 40–50 cm, khung chỉ ôm 1 nhãn |

**Ba câu phải hỏi người bán trước khi chốt đơn:**

1. **Có ép được H.264 không?** Nhiều camera đời mới mặc định H.265 để tiết kiệm ổ. Phải vào
   chỉnh về H.264 **và** tắt "Smart Codec"/"H.264+"/VBR. Camera *chỉ* có H.265 thì **không dùng
   được** — không phải bất tiện, mà là clip bằng chứng có thể fail hẳn.
2. **Camera quét mã có xuất được hình dọc không?** (portrait / "corridor mode" / xoay 90°).
   Hikvision và Dahua đều có, nhưng dòng rẻ nhất đôi khi không. Hệ **không xoay hộ**.
3. **Có sub-stream không, và chỉnh được không?** Thiếu sub-stream thì mọi lần xem từ xa đi
   main-stream, tốn 4–8 lần băng thông upload của kho.

**Đừng mua:** camera 4K (trên trần 2K là phí, chỉ tốn ổ và LAN), camera có zoom/varifocal
(góc đặt cố định, không dùng tới), camera Wi-Fi, webcam USB.
