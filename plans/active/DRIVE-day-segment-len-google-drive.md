# DRIVE — Đẩy segment lên Google Drive thay vì chỉ lưu ở máy kho

**Trạng thái:** Kế hoạch, chưa viết dòng mã nào
**Ngày:** 25/09/2026
**Chủ dự án chốt:** nơi lưu là **Google Drive**; mục tiêu là **an toàn khi máy kho hỏng** và **đỡ tốn ổ đĩa máy kho**. KHÔNG đặt mục tiêu xem lại từ xa hay kéo dài hạn lưu quá 35 ngày.
**Liên quan:** `E.1-ip-camera-co-dinh-va-remote-live.md` (bài học băng thông), `D.1-proof-queue-pip.md` (đường tải clip đang chạy), `warehouse-agent/RELEASES.md` mục 0.11.0 (disk guard)

---

## 0. Kết luận trước, lý lẽ sau

**Đẩy nguyên segment gốc lên Drive là việc KHÔNG chạy được trên đường mạng hiện tại.** Đây không phải ý kiến, là phép chia:

| Đại lượng | Số đo được | Nguồn |
|---|---|---|
| Một camera ghi ra | **17 MB mỗi phút** (≈ 1 GB mỗi giờ) | 1.762 segment trên `D:\beta_cam_recordings`, tổng 29,3 GB |
| Camera nhẹ nhất đang có | 7,5–8 MB mỗi phút (≈ 0,47 GB/giờ) | `CAM_TEST_20260917_*.mp4` |
| Đường lên của kho | **198 KB/s** (≈ 0,68 GB mỗi giờ) | Đo 24/09 khi đẩy file 81 MB lên GitHub |
| Kho 2 bàn × 2 camera, ca 10 giờ | **40 GB mỗi ngày** cần đẩy | 4 × 10 × 1 GB |
| Đường mạng chở được cả ngày | **16,7 GB** (nếu chạy 100% suốt 24 giờ) | 0,68 × 24 |

Thiếu **2,4 lần** — và đó là khi giả định đường mạng dành trọn cho việc này, trong khi nó còn phải tải clip bằng chứng, chạy heartbeat, và kho còn dùng mạng cho việc khác. Một camera thôi đã ăn hết đường lên.

**Nên kế hoạch này KHÔNG phải "đẩy segment lên Drive". Nó là: giữ lại thứ đáng giữ, ở dạng đủ dùng, trong khả năng đường mạng.** Ba tầng:

| Tầng | Cái gì lên Drive | Dung lượng ước tính | Vì sao |
|---|---|---|---|
| **A. Bản lưu trữ nhẹ** | MỌI giờ có ca, nén xuống ~300 kbps | 135 MB/giờ-camera → **5,4 GB/ngày** cho 4 camera | Đủ nhìn thao tác đóng gói, đủ đối chất. Chiếm ~31% đường lên — chạy được |
| **B. Đoạn gốc quanh lượt quét** | Segment trùng khung giờ có đơn bị đánh dấu lỗi / có khiếu nại | Vài trăm MB/ngày | Đây là chỗ cần chất lượng gốc, và là chỗ mất tiền nếu thiếu |
| **C. Không đẩy** | Giờ không có ca, camera không gắn bàn | 0 | Không ai xem, không ai cần |

**Hai việc phải làm TRƯỚC khi viết mã**, vì làm sai thứ tự là hỏng cả kế hoạch:

1. **Đo băng thông thật tại kho Đại Kim** (§2). Con số 198 KB/s đo ở máy lập trình, không phải ở kho. Kho có thể nhanh hơn, có thể chậm hơn. Đo xong mới chốt được tầng A có khả thi không.
2. **Đo dung lượng thật của từng camera tại kho** (§2). 17 MB/phút là trung bình máy này; camera 4MP ở kho có thể gấp rưỡi.

Và **một điều không được làm**: không xoá file ở máy kho trước khi Drive xác nhận đã nhận đủ byte. Mất video là mất bằng chứng, không có đường lùi.

---

## 1. Hiện trạng (đọc từ mã, không phải giả định)

**Segment sống và chết tại máy kho.** Agent ghi liên tục thành file 60 giây vào `RECORDING_DIR` ([recording.ts](../../warehouse-agent/src/recording.ts)), đặt tên `<mã_camera>_<YYYYMMDD>_<HHMMSS>.mp4`. Hết hạn thì `cleanup-segments.ps1` xoá. Không có đường nào đưa segment ra khỏi máy.

**Thứ DUY NHẤT hiện rời khỏi máy kho là clip bằng chứng** — đoạn đã cắt theo từng đơn, ghép hai camera, tải lên kho lưu trữ Supabase qua đường: `enqueueCutClip` → agent cắt → `clip-cut-result` → xin URL ký ở `clip-upload-url` → PUT thẳng lên kho lưu trữ → `clip-upload-complete` đối chiếu kích thước. Có hộp thư đi gửi lại khi mạng hỏng, có trần 90 MiB mỗi clip.

**Đường tải lên đã có sẵn ba thứ rất quý**, dùng lại được gần như nguyên vẹn cho Drive:

- **Cloud giữ khoá, agent không giữ.** Agent xin URL tải lên rồi mới đẩy. Đúng cái ta cần cho Drive: refresh token của Google nằm ở cloud, agent chỉ nhận một phiên tải dùng một lần.
- **Hộp thư đi bền bỉ** ([clip-result-outbox.ts](../../warehouse-agent/src/clip-result-outbox.ts)): gửi không được thì ghi xuống ổ và gửi lại mỗi phút, sống qua khởi động lại.
- **Đối chiếu kích thước sau khi tải** — bài học đau từ 0.10.1: clip lên rồi vẫn bị đánh là hỏng. Drive cũng phải đối chiếu như vậy.

**Disk guard (0.11.0) đã biết xoá segment cũ nhất khi sắp đầy ổ**, ngưỡng tính theo số giờ ghi còn lại. Kế hoạch này phải nối vào đó: *đã lên Drive* trở thành một điều kiện để được xoá sớm.

**Chưa có gì về Google trong repo.** Không thư viện, không khoá, không bảng. Toàn bộ là mới.

---

## 2. Bước 0 — Đo trước, quyết sau (1 buổi, không viết mã sản phẩm)

Không có bước này thì mọi con số dưới đây là đoán.

| Đo cái gì | Cách đo | Ngưỡng quyết định |
|---|---|---|
| Đường lên thật của kho, giờ cao điểm và giờ đêm | Chạy `speedtest-cli` hoặc đẩy một file 200 MB lên Drive, đo 3 lần trong ngày | < 500 KB/s → chỉ làm tầng B; ≥ 1 MB/s → làm cả tầng A |
| Dung lượng mỗi camera mỗi giờ | Đếm `Get-ChildItem` trên `RECORDING_DIR` trong 24 giờ, chia theo camera | Vào bảng tính dung lượng Drive |
| Chỗ trống ổ máy kho, tốc độ đầy | `--disk-guard-dry-run` (đã có sẵn) | Quyết số ngày giữ local sau khi có Drive |
| CPU còn dư | Task Manager lúc đang ghi 4 camera + đọc QR | Quyết được phép nén lại (tầng A) hay không |

**Kết quả bước 0 phải ghi vào `plans/reports/`** rồi mới sang bước 1.

---

## 3. Kiến trúc

```
Máy kho (agent)                       Cloud                      Google Drive
───────────────                       ─────                      ────────────
segment đóng                          giữ refresh token
   │                                  của tài khoản Drive
   ├─ chọn: có thuộc giờ ca?
   ├─ nén bản nhẹ (tầng A)
   │                                       
   ├── POST /api/agent/drive-upload-url ──►
   │        {camera, giờ, cỡ file, loại}
   │                                  ├─ kiểm hạn ngạch tổ chức
   │                                  ├─ tạo phiên tải resumable
   │   ◄────── {upload_url, file_id} ─┤       (Drive API)
   │
   ├── PUT bytes ──────────────────────────────────────────────►
   │
   ├── POST /api/agent/drive-upload-done ►
   │        {file_id, cỡ thật, băm}    ├─ đối chiếu cỡ với Drive
   │                                  ├─ ghi bảng drive_segments
   │   ◄────── {ok, được_xoá_local} ──┤
   │
   └─ chỉ khi ok: đánh dấu segment được phép xoá sớm
```

**Vì sao agent đẩy thẳng lên Drive chứ không qua cloud:** đi qua cloud là tốn băng thông hai lần và biến Vercel thành ống dẫn video — thứ nó không làm được (giới hạn thời gian mỗi request, giới hạn kích thước body).

**Vì sao cloud giữ khoá:** refresh token của Google mở được toàn bộ Drive của tài khoản đó. Đặt ở máy kho là đặt vào chỗ nhiều người ra vào nhất, không khoá màn hình, và ta không kiểm soát được. Cloud cấp phiên tải dùng một lần cho đúng một file.

---

## 4. Việc cụ thể theo đợt

### Đợt 1 — Đường ống một chiều, một camera, thủ công (3–4 ngày)

Mục tiêu: một segment thật đi được từ máy kho lên Drive và xác nhận đủ byte.

- **Database:** bảng `drive_segments` (`organization_id`, `camera_id`, `segment_started_at`, `local_path`, `drive_file_id`, `bytes`, `sha256`, `tier` = `archive|original`, `uploaded_at`, `verified_at`, `local_deleted_at`). Khoá duy nhất `(camera_id, segment_started_at, tier)` — chống tải lên hai lần.
- **Bảng cấu hình:** `organizations.drive_folder_id`, `drive_refresh_token_ciphertext` (mã hoá như mật khẩu camera đang làm), `drive_enabled`, `drive_daily_quota_gb`.
- **Cloud:** `POST /api/agent/drive-upload-url` (ký HMAC v2 như các route agent khác) và `POST /api/agent/drive-upload-done`.
- **Agent:** module `drive-uploader.ts` — hàng đợi bền trên ổ đĩa, nối vào `segment-watcher.ts` (segment đóng thì xếp hàng), giới hạn 1 file một lúc, gửi lại khi hỏng.
- **Chốt an toàn:** chưa đụng gì tới việc xoá file. Đợt này chỉ tải lên.

**Xong đợt 1 là:** bật cho MỘT camera ở kho test, chạy một ngày, đối chiếu số file trên Drive với số segment ở máy.

### Đợt 2 — Bản lưu trữ nhẹ (tầng A) (3 ngày)

- Nén lại bằng ffmpeg khi segment đóng: `-c:v libx264 -crf 32 -preset veryfast -vf scale=-2:480 -an` → ước 135 MB/giờ-camera. **Đo CPU thật ở kho trước khi bật cho mọi camera** (bước 0 đã trả lời).
- Nếu CPU không đủ: dùng bộ mã hoá phần cứng có sẵn (`encode-gate.ts` đã biết chọn QSV/NVENC/AMF), hoặc hạ xuống 15 khung/giây.
- Chỉ nén và đẩy segment **thuộc giờ có ca** — đọc từ `staff_work_sessions`, không đẩy giờ kho đóng cửa.

### Đợt 3 — Ưu tiên đoạn gốc quan trọng (tầng B) (2 ngày)

- Segment trùng khung giờ của: đơn bị đánh dấu lỗi, kiện hoàn có hồ sơ khiếu nại, lượt quét trùng → đẩy **bản gốc**, chen lên đầu hàng đợi.
- Đây là chỗ đáng giá nhất: khi có tranh chấp, người ta cần đúng đoạn đó ở chất lượng gốc.

### Đợt 4 — Nối vào disk guard, cho phép xoá sớm (2 ngày)

- `cleanup-segments.ps1` và disk guard thêm điều kiện: segment **đã có `verified_at` trên Drive** thì được xoá sớm hơn hạn chung (ví dụ giữ local 7 ngày thay vì 35).
- **Bất biến tuyệt đối:** chưa `verified_at` thì KHÔNG xoá sớm, dù ổ có đầy. Ổ đầy thì báo động, không đánh đổi bằng chứng.
- Cấu hình kho thêm ô "Số ngày giữ segment ở máy kho khi đã có bản trên Drive".

### Đợt 5 — Nhìn thấy được, kiểm được (2 ngày)

- Trang Máy trạm kho thêm khối: hôm nay đẩy bao nhiêu, tồn đọng bao nhiêu, lần cuối thành công lúc nào, dung lượng Drive đã dùng.
- Báo động khi: tồn đọng > 6 giờ, hoặc hạn ngạch Drive sắp hết, hoặc refresh token hết hiệu lực.
- **Không có khối này thì cả hệ thống là im lặng hỏng** — đúng cái bệnh mà disk guard 0.11.0 vừa đi chữa.

---

## 5. Những chỗ Google Drive sẽ cắn

| Cái gì | Số thật | Ảnh hưởng |
|---|---|---|
| Hạn tải lên mỗi tài khoản | **750 GB/ngày** | Không chạm tới với 5,4 GB/ngày, nhưng nhiều kho dùng chung một tài khoản thì phải chia |
| Tài khoản dịch vụ không có Drive riêng | Phải dùng **Shared Drive** (Drive dùng chung), không phải "My Drive" | Quyết ngay từ đầu, đổi về sau là chuyển toàn bộ file |
| Số file | 1 segment/phút/camera = **5.760 file/ngày** với 4 camera | Drive chậm khi một thư mục có hàng trăm nghìn file → chia thư mục theo `kho/camera/năm/tháng/ngày` |
| Giới hạn gọi API | ~12.000 lượt/phút mỗi dự án | Đủ, nhưng phải có backoff khi gặp 429 |
| Token hết hiệu lực | Refresh token bị thu hồi khi đổi mật khẩu Google, hoặc 6 tháng không dùng | Phải có báo động, không để phát hiện lúc cần video |

---

## 6. Rủi ro và cách chặn

| Rủi ro | Hậu quả | Chặn bằng |
|---|---|---|
| Xoá local trước khi Drive nhận đủ | **Mất bằng chứng vĩnh viễn** | Chỉ xoá khi có `verified_at`; đối chiếu cả kích thước lẫn băm sha256 |
| Đẩy chiếm hết đường mạng, clip bằng chứng bị chậm | Khách bấm xem video không có | Clip bằng chứng luôn ưu tiên; segment chỉ dùng băng thông còn thừa, có trần KB/s cấu hình được |
| Nén làm mờ mất chữ trên nhãn | Bản lưu trữ vô dụng | Tầng A chỉ để xem thao tác; chữ trên nhãn đã có ở clip bằng chứng và ở tầng B |
| Một kho ăn hết hạn ngạch của tài khoản chung | Kho khác không đẩy được | Hạn ngạch theo tổ chức (`drive_daily_quota_gb`), đếm ở cloud |
| Rò khoá Drive | Lộ toàn bộ video mọi kho | Token chỉ ở cloud, mã hoá; agent chỉ nhận phiên tải một file; phạm vi quyền `drive.file` (chỉ file do ứng dụng tạo) |

---

## 7. Không làm trong kế hoạch này

- **Không xem lại segment từ xa qua giao diện.** Chủ dự án không đặt mục tiêu này. Làm thêm là phải có trình phát, phân quyền, ký URL Drive — một kế hoạch riêng.
- **Không kéo dài hạn lưu quá 35 ngày.** Giữ nguyên, chỉ đổi chỗ nằm.
- **Không đẩy segment của camera chưa gắn bàn.**
- **Không đụng vào đường clip bằng chứng đang chạy.** Nó đang đúng; thêm việc cho nó là thêm chỗ hỏng.

---

## 8. Câu hỏi cần chủ dự án trả lời trước đợt 1

1. **Tài khoản Drive nào?** Google Workspace của công ty (có Shared Drive, hạn ngạch theo gói) hay tài khoản cá nhân 15 GB? Với 5,4 GB/ngày thì tài khoản 15 GB đầy sau 3 ngày.
2. **Giữ bao lâu trên Drive?** Kế hoạch đang giả định 35 ngày như hạn local. 35 ngày × 5,4 GB = **190 GB** cho một kho.
3. **Một tài khoản cho mọi kho, hay mỗi kho một tài khoản?** Ảnh hưởng tới hạn ngạch và tới việc khách có xem được video kho khác không.
