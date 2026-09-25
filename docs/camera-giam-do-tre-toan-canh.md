# Chỉnh camera cho hết lệch 1 giây giữa toàn cảnh và QR

**Người thực hiện:** người có tài khoản quản trị camera và switch tại kho.
**Địa điểm:** kho KĐT Đại Kim.
**Thời gian ước:** 60–90 phút, phần lớn là đo lại sau mỗi bước.
**Triệu chứng:** camera toàn cảnh luôn chậm hơn camera QR khoảng 1 giây.

---

## 0. Vì sao phải sửa, không chỉ là khó nhìn

Máy kho đặt tên đoạn video theo **giờ của máy tính lúc ghi**, không phải giờ cảnh xảy ra. Khi cắt clip bằng chứng, hệ thống cắt **cùng một khoảng giờ** trên cả hai camera.

Nên nếu luồng toàn cảnh về chậm 1 giây, thì ở cùng một điểm phát, clip toàn cảnh đang chiếu cảnh của **1 giây trước** so với clip QR. Khi đối soát một đơn, hai góc không khớp nhau.

Hệ thống **không có chỗ nào bù độ trễ theo camera**. Phải sửa tại camera.

---

## 1. Số đo hiện tại (đo 25/09/2026, từ đoạn video 4 ngày)

| Camera | Vai trò | Model | Trung bình | Giữa | p95 | Đỉnh | Dáng |
|---|---|---|---|---|---|---|---|
| **CTC01** | Toàn cảnh | Hikvision DS-2CD2043G2-LI2U (4MP) | **5.88 Mbps** | 5.84 | 6.32 | 6.92 | dải rất hẹp → **CBR** |
| **CQR01** | Quét QR | Dahua DH-IPC-HFW5243F-ZYL-AS (2MP) | 2.73 Mbps | 2.09 | 4.33 | 5.53 | dao động rộng → **VBR** |

Hai kết luận từ bảng này:

- Camera toàn cảnh chạy **CBR ở mức chặt**. 4MP H.264 (2688×1520) thường cần 6–8 Mbps; đặt CBR 6 Mbps là bộ mã hoá phải gò liên tục, và cách nó gò là **giữ khung hình lại**. Dải 5.84–6.92 hẹp như vậy đúng là dấu vết đó. Đây là **trễ cố định**, khớp với "luôn chậm 1 giây".
- **5.88 Mbps liên tục là 59% của một cổng 10 Mbps.** Nếu cổng đó đang bật chế độ Extend thì đủ để gây xếp hàng.

---

## 2. Chuẩn bị — cách đo, làm TRƯỚC khi đổi gì

Không đo thì không biết bước nào có tác dụng.

1. Mở một **đồng hồ bấm giờ hiện mili giây** trên điện thoại (ứng dụng Stopwatch mặc định là đủ).
2. Đặt điện thoại sao cho **cả hai camera cùng nhìn thấy màn hình**.
3. Mở hai luồng trực tiếp cạnh nhau trên màn hình máy kho.
4. Chụp một ảnh màn hình. Đọc hai con số, lấy hiệu.

Ghi vào bảng cuối tài liệu. **Lặp lại đúng cách này sau mỗi bước.**

> Đo bằng mắt thường ("thấy chậm chậm") không dùng được — chênh 300ms và chênh 1.200ms nhìn như nhau, mà cách xử lý thì khác hẳn.

---

## 3. Việc KHÔNG được làm

**Không đổi camera sang H.265.** Máy kho chỉ coi **H.264** là xem được trên trình duyệt; codec khác bị gắn cờ và clip phải chuyển mã, đốt CPU máy kho — vốn đã phải gánh việc đọc QR ở độ phân giải gốc. Muốn nhẹ băng thông thì **hạ độ phân giải**, không đổi codec.

**Không hạ độ phân giải camera QR.** Đã cam kết đọc được mã QR nhỏ 2×2cm ở khoảng cách 50cm; hạ độ phân giải là phá cam kết đó.

**Không đổi cài đặt trong giờ kho làm việc.** Xem mục 5.

---

## 4. Năm bước, theo thứ tự

### Bước 1 — Kiểm tra tốc độ cổng trên switch (làm đầu tiên, sửa không mất gì)

Switch `DS-3E1106P-EI/M` có chế độ **Extend / Long Range** cho cổng 1–4: truyền được tới 300m, nhưng **cổng tụt xuống 10 Mbps**.

**Làm:** vào Hik-Partner Pro → sơ đồ mạng → xem tốc độ kết nối của cổng đang cắm camera toàn cảnh.

| Thấy gì | Làm gì |
|---|---|
| **100 Mbps** | Không phải nguyên nhân. Sang bước 2 |
| **10 Mbps** và cáp dưới 100m | **Tắt Extend** cho cổng đó. Đo lại ngay |
| **10 Mbps** và cáp trên 100m | Phải giữ Extend. Bắt buộc làm bước 2 để hạ băng thông |

### Bước 2 — Hạ camera toàn cảnh từ 4MP xuống 1080p ⭐ khuyên nhất

Bước này giải quyết **ba việc cùng lúc**:

- bộ mã hoá hết phải gò → hết trễ do đệm
- băng thông còn khoảng một nửa → hết nghi ngờ nghẽn cổng
- **ổ đĩa máy kho bớt đầy** — đang còn ~186 GB trống, đốt ~31 GB/ngày, tức khoảng 6 ngày nữa là hết

Góc toàn cảnh chỉ cần thấy thao tác đóng gói. 1080p thừa sức. Giữ 4MP là phí ở cả ba mặt.

**Làm (giao diện web camera Hikvision):**
`Configuration → Video/Audio → Video`

| Mục | Đặt thành |
|---|---|
| Stream Type | Main Stream (Normal) |
| Resolution | **1920×1080** |
| Bitrate Type | **Variable** (VBR) |
| Max. Bitrate | **4096 Kbps** |
| Video Quality | Higher |
| Video Encoding | **H.264** (giữ nguyên) |

Bấm **Save**.

> **Nếu bắt buộc giữ 4MP:** phải nâng Max. Bitrate lên **8192 Kbps** hoặc đổi sang VBR — nhưng như vậy ổ đĩa đầy nhanh hơn nữa, mà chuyện đó đang là vấn đề rồi. Cân nhắc kỹ.

### Bước 3 — Khoảng I-frame = số khung hình mỗi giây, CẢ HAI camera

Bước này **đáng làm kể cả khi đã hết trễ**.

Máy kho ghi và cắt clip bằng cách sao chép nguyên luồng, nên **chỉ cắt được tại khung I**. Khoảng I-frame 2 giây nghĩa là điểm bắt đầu clip lệch tới 2 giây so với mốc yêu cầu — và **lệch khác nhau ở hai camera** vì hai máy đặt khác nhau. Đây là sai số nhảy nhót, độc lập với độ trễ đường truyền.

**Hikvision (toàn cảnh):** `Configuration → Video/Audio → Video`
- Frame Rate: **25 fps**
- I Frame Interval: **25**

**Dahua (QR):** `Cài đặt → Camera → Mã hoá video`
- Số khung hình (FPS): **25**
- Khoảng I-frame: **25**

Hai camera phải **cùng số khung hình mỗi giây**.

### Bước 4 — Profile High → Main (camera toàn cảnh)

Profile High dùng **khung B**: bộ mã hoá phải giữ khung lại để sắp xếp thứ tự trước khi gửi. Thêm vài trăm mili giây, và làm dấu thời gian trong file rối hơn khi máy kho sao chép nguyên luồng.

**Hikvision:** `Configuration → Video/Audio → Video → Profile` → đặt **Main**.

### Bước 5 — Màn trập và xử lý hình ảnh (camera toàn cảnh)

Cảm biến hai máy chênh nhau nhiều: toàn cảnh là 1/3" 4MP ở 0.005 Lux, camera QR là 1/2.8" 2MP ở 0.001 Lux — **nhạy sáng hơn khoảng 5 lần**, điểm ảnh lại to hơn nhiều. Kho hơi tối là camera toàn cảnh tự kéo dài phơi sáng, cộng khử nhiễu 3D và WDR gộp nhiều lần phơi, mỗi thứ một hai khung hình.

**Hikvision:** `Configuration → Image → Display Settings`

| Mục | Đặt thành | Ghi chú |
|---|---|---|
| Exposure Time / Shutter | giới hạn chậm nhất **1/50** | Hình sẽ tối hơn — nếu tối quá thì thêm đèn, đừng nới lại |
| WDR | thử **Off** | Chỉ bật nếu khung hình thật sự có chỗ quá sáng và chỗ quá tối |
| 3D DNR | giảm xuống mức thấp | Khử nhiễu mạnh = giữ nhiều khung để so sánh |

Cân nhắc **tắt AcuSense** (`Configuration → Event → Smart Event`) trên camera toàn cảnh: nó chạy AI phân loại người/phương tiện ngay trong luồng hình, mà việc này chỉ cần làm bằng chứng.

> **Với camera QR thì màn trập nhanh lại có lợi**: mã QR 2×2cm chỉ cần nhoè khoảng nửa milimét là không đọc được. Nếu có sẵn ánh sáng thì đặt giới hạn màn trập của camera QR ở **1/100** trở lên.

---

## 5. Sau khi đổi — bắt buộc khởi động lại ghi hình

Máy kho đang sao chép nguyên luồng từ camera. Đổi độ phân giải hoặc profile **trong lúc đang ghi** thì tiến trình ghi hiện tại không hiểu luồng mới nữa — đoạn video ra có thể hỏng.

**Làm trên máy kho, ngoài giờ làm việc**, PowerShell quyền quản trị:

```powershell
Restart-Service BetacomAgent
Get-Service BetacomAgent
```

Rồi kiểm lại nhật ký, phải **không còn** dòng `corrupt decoded frame`:

```powershell
Get-Content "C:\Program Files\BetacomAgent\logs\agent-stdout.log" -Tail 40
```

Sau đó mở trang Giám sát đóng hàng, xem trực tiếp cả hai camera có lên hình không, rồi quét thử một mã và bấm tạo clip cho đơn đó.

---

## 6. Bảng ghi kết quả

| Bước | Làm gì | Độ lệch đo được | Ghi chú |
|---|---|---|---|
| — | Trước khi đổi gì | ~1000 ms | |
| 1 | Tắt Extend trên switch | | Cổng trước/sau: ___ → ___ Mbps |
| 2 | Hạ xuống 1080p, VBR 4 Mbps | | |
| 3 | I-frame = 25, cả hai máy | | |
| 4 | Profile → Main | | |
| 5 | Màn trập 1/50, WDR off | | Hình có đủ sáng không: ___ |

**Đạt yêu cầu khi độ lệch dưới 200 ms.** Dưới mức đó thì mắt thường không phân biệt được khi xem hai góc cạnh nhau.

---

## 7. Còn lệch bao nhiêu thì bù bằng phần mềm

Hệ thống đã có chỗ nhận con số này (25/09/2026). Mỗi camera có một thông số **độ trễ luồng, tính bằng mili giây**; khi cắt clip, hệ thống tự dịch cửa sổ của camera đó đi đúng ngần ấy.

Đo xong, điền vào bằng lệnh này trên máy lập trình:

```
node scripts/set-camera-latency.mjs CTC01 1000
```

Chạy không kèm tham số thì chỉ xem giá trị hiện tại của mọi camera.

**Chỉ đặt cho camera toàn cảnh.** Mốc quét sinh ra từ chính camera QR — nó giải mã xong khung hình nào thì lấy giờ lúc đó — nên độ trễ của camera QR **tự triệt tiêu**. Để camera QR ở 0.

Sau khi đổi, tạo lại clip cho một đơn cũ rồi xem hai góc đã khớp chưa. Không cần khởi động lại gì: đây là phần chạy trên máy chủ, không phải máy kho.

> **Vẫn phải làm năm bước trên trước.** Bù bằng con số chỉ đúng khi độ trễ **cố định**. Nếu gốc là nghẽn băng thông ở cổng 10 Mbps thì lúc đông hàng trễ 1,5 giây, lúc vắng trễ 0,4 giây — điền số nào cũng sai, mà lại sai một cách khó thấy hơn bây giờ.

---

## 8. Nếu phải lùi lại

Mọi bước ở trên đều đổi được về như cũ ngay trên giao diện web của camera. Giá trị trước khi đổi:

| Camera | Mục | Giá trị cũ |
|---|---|---|
| Toàn cảnh | Resolution | 2688×1520 (4MP) |
| Toàn cảnh | Bitrate | CBR ~6000 Kbps (đo được 5.88 Mbps) |
| Toàn cảnh | Codec | H.264 |
| QR | Bitrate | VBR, trung bình 2.73 Mbps |
| QR | Codec | H.264 |

Đổi lại xong nhớ **khởi động lại dịch vụ** như mục 5.
