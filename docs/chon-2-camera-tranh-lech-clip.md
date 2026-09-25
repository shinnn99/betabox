# Chọn 2 camera cho một bàn đóng hàng — để clip không bị lệch

**Dùng khi:** mua camera cho kho mới, hoặc thay camera ở kho đang chạy.
**Người đọc:** người chọn hàng và đặt mua, hoặc đơn vị lắp đặt.

---

## 0. Một câu tóm tắt

**Mua hai camera GIỐNG HỆT NHAU.** Cùng hãng, cùng model, cùng phiên bản phần mềm. Hai góc khác nhau thì chỉnh bằng **zoom**, không phải bằng hai model khác nhau.

Phần còn lại của tài liệu giải thích vì sao, và những gì cần kiểm khi không thể mua giống hệt.

---

## 1. Vì sao lệch camera lại thành lệch clip

Hệ thống ghép hai góc bằng **đồng hồ của máy kho**, không phải giờ camera chụp được cảnh:

- Máy kho đặt tên đoạn video theo giờ máy lúc ghi
- Mốc quét là giờ máy lúc giải mã xong khung hình QR
- Cắt clip thì cắt **cùng một khoảng giờ** trên cả hai camera

Nên nếu một camera đưa hình về chậm hơn camera kia, hai clip ghép ra **lệch đúng bằng khoảng chênh đó**. Xem một đơn, hai góc chiếu hai thời điểm khác nhau.

**Thứ quan trọng không phải độ trễ, mà là CHÊNH LỆCH độ trễ giữa hai camera.** Cả hai cùng chậm 400ms thì không sao. Một con 200ms, một con 1200ms thì hỏng.

Hệ thống **không tự bù** chỗ này. Chọn sai từ đầu là sống chung với nó.

> **Ví dụ thật — kho KĐT Đại Kim:** toàn cảnh là Hikvision 4MP, QR là Dahua 2MP. Hai hãng, hai cỡ cảm biến, hai đời xử lý ảnh. Kết quả: **toàn cảnh chậm hơn QR 1 giây**, và không có cách nào chỉnh cho bằng ngoài việc hạ cấu hình con nặng hơn.

---

## 2. Bảy tiêu chí, theo mức quan trọng

### ⭐ 1. Cùng model — quan trọng hơn tất cả phần còn lại cộng lại

Độ trễ của một camera là tổng của: phơi sáng → xử lý ảnh (WDR, khử nhiễu) → nén → đẩy ra mạng. Mỗi hãng làm một kiểu, mỗi đời một khác. **Hai model khác nhau thì không có cách nào ép cho bằng**, dù đặt cùng độ phân giải và cùng số khung hình.

Cùng model thì độ chênh thường dưới 50ms — coi như không có.

### ⭐ 2. Chọn model có zoom chỉnh được, để hai góc khác nhau mà máy vẫn giống nhau

Đây là cách giải quyết mâu thuẫn "một góc rộng, một góc cận" mà không phải mua hai loại:

| Vai trò | Cần gì |
|---|---|
| Toàn cảnh | Góc rộng, thấy cả bàn và người |
| Quét QR | Khung chỉ hơn tờ A6 một chút, ở khoảng cách 50cm |

Mua **hai camera cùng model có ống kính zoom chỉnh điện (motorized / varifocal)**, rồi chỉnh zoom khác nhau. Con Dahua đang dùng ở Đại Kim (2.7–13.5mm) là đúng dạng này.

Tránh mua camera ống kính cố định cho vai trò QR — đặt sai khoảng cách một chút là phải đổi cả máy.

### 3. Cùng độ phân giải và cùng số khung hình mỗi giây

**Không cần cao. Cần BẰNG NHAU.**

Đề xuất cho cả hai: **1080p, 25 hình/giây**.

Camera 4MP không làm bằng chứng tốt hơn 1080p bao nhiêu, nhưng ăn gấp đôi băng thông và gấp đôi ổ đĩa — mà ổ đĩa máy kho là thứ hay đầy nhất. Riêng camera QR thì độ phân giải có ích thật (đọc mã nhỏ), nên nếu chọn cao hơn thì **để cả hai cùng cao**, đừng để lệch nhau.

### 4. Phải có H.264

Hệ thống chỉ coi **H.264** là xem được thẳng trên trình duyệt. Codec khác thì clip phải chuyển mã, đốt CPU máy kho.

Mọi camera IP bây giờ đều có H.264, nên đây là tiêu chí dễ — chỉ cần nhớ **đặt về H.264 khi lắp**, đừng để mặc định H.265.

### 5. Tránh camera có tính năng "thông minh" nằm trong luồng hình

Những thứ dưới đây đều **giữ khung hình lại** để xử lý, mỗi cái thêm một ít độ trễ:

| Tính năng | Vấn đề |
|---|---|
| Nén thông minh (H.264+, H.265+, Smart Codec) | Dựng mô hình nền, phải giữ khung để quyết định |
| AI trên camera (AcuSense, SMD, phân loại người/xe) | Chạy nhận dạng ngay trong luồng |
| WDR mạnh (120dB) | Gộp nhiều lần phơi sáng thành một khung |
| Khử nhiễu 3D mức cao | So sánh nhiều khung liên tiếp |

Không phải cấm — **tắt được là đủ**. Nhưng nếu một camera có mà camera kia không có thì lệch, kể cả khi cùng hãng. Kiểm bảng thông số trước khi mua.

### 6. Cùng cỡ cảm biến và cùng độ nhạy sáng

Đây là tiêu chí **dễ bỏ qua nhất mà hậu quả tệ nhất**.

Camera nhạy sáng kém, trong kho hơi tối, sẽ **tự kéo dài thời gian phơi sáng**. Camera nhạy hơn thì giữ màn trập nhanh. Hai con lệch nhau — và **lệch thay đổi theo ánh sáng trong ngày**: sáng sớm khác giữa trưa khác chiều tối.

Loại lệch này **không bù được bằng một con số cố định**. Nó là loại tệ nhất.

Ở Đại Kim: toàn cảnh là cảm biến 1/3" 4MP ở 0.005 Lux, QR là 1/2.8" 2MP ở 0.001 Lux — nhạy hơn khoảng 5 lần, điểm ảnh lại to hơn nhiều. Chênh nhau ngay từ tờ thông số.

### 7. Đi mạng giống nhau

Hai camera phải:
- cắm vào **cùng một switch**, cùng loại cổng
- **cùng tốc độ cổng** — cẩn thận chế độ Extend / Long Range 300m, nó kéo cổng xuống **10 Mbps**
- không con nào đi qua bộ mở rộng PoE, powerline hay wifi mà con kia thì không

---

## 3. Bảng kiểm khi hỏi nhà cung cấp

Gửi thẳng bảng này cho bên bán, yêu cầu điền:

| Mục | Camera 1 (toàn cảnh) | Camera 2 (QR) | Phải |
|---|---|---|---|
| Hãng và model | | | **giống hệt** |
| Phiên bản phần mềm | | | giống hệt |
| Ống kính | | | **zoom chỉnh được** |
| Cỡ cảm biến | | | giống hệt |
| Độ nhạy sáng (Lux) | | | giống hệt |
| Độ phân giải đặt khi lắp | | | **bằng nhau** (1080p) |
| Số khung hình mỗi giây | | | **bằng nhau** (25) |
| Chuẩn nén | | | **H.264** cả hai |
| Nén thông minh tắt được không | | | có |
| AI trên camera tắt được không | | | có |

---

## 4. Nghiệm thu — làm TRƯỚC khi bắt vít cố định

Không đo thì không biết, và tháo ra lắp lại thì tốn gấp mấy lần.

1. Cắm cả hai camera, đặt đúng cấu hình sẽ dùng thật (độ phân giải, số khung hình, H.264, tắt nén thông minh và AI).
2. Đặt **điện thoại bấm giờ hiện mili giây** sao cho cả hai camera cùng nhìn thấy.
3. Mở hai luồng trực tiếp cạnh nhau, chụp một ảnh màn hình.
4. Đọc hai con số, lấy hiệu.

| Chênh lệch | Kết luận |
|---|---|
| **Dưới 200 ms** | Đạt. Mắt thường không phân biệt được |
| 200–500 ms | Chấp nhận được nhưng nên tìm nguyên nhân — thường là một tính năng xử lý ảnh chưa tắt |
| **Trên 500 ms** | **Không nhận hàng.** Hai máy không cùng đường xử lý ảnh |

Đo lại lần nữa **vào lúc kho tối nhất trong ngày**. Nếu con số đổi nhiều so với lần đo ban ngày thì vấn đề nằm ở độ nhạy sáng — xem tiêu chí 6, và cách chữa là **thêm đèn**, không phải chỉnh camera.

---

## 5. Nếu buộc phải dùng hai model khác nhau

Có khi không tránh được — kho đã có sẵn một camera, hoặc ngân sách chỉ cho phép thế. Khi đó:

1. **Ép hai bên về cùng một mẫu số**: cùng độ phân giải, cùng số khung hình, cùng H.264, tắt hết nén thông minh và AI trên **cả hai**, cùng giới hạn màn trập chậm nhất.
2. **Hạ con nặng hơn xuống ngang con nhẹ**, đừng nâng con nhẹ lên. Nâng lên là tốn băng thông và ổ đĩa mà độ trễ không chắc giảm.
3. **Đo lại sau mỗi lần chỉnh.** Cách đo ở mục 4.
4. Chi tiết từng bước cho cặp Hikvision + Dahua đang dùng ở Đại Kim: xem [camera-giam-do-tre-toan-canh.md](camera-giam-do-tre-toan-canh.md).

Và chấp nhận trước: **hai model khác nhau thì gần như không bao giờ về được dưới 200ms.** Ép về 300–400ms đã là tốt.

---

## 6. Ba điều đừng làm

**Đừng mua camera toàn cảnh xịn hơn camera QR.** Nghe hợp lý — góc toàn cảnh thấy nhiều thứ hơn — nhưng camera nặng hơn thường **chậm hơn**, và nó kéo theo băng thông lẫn ổ đĩa. Góc toàn cảnh chỉ cần thấy thao tác đóng gói.

**Đừng để mỗi camera một cấu hình "tối ưu riêng".** Người lắp hay có thói quen chỉnh từng con cho đẹp nhất. Ở đây **giống nhau quan trọng hơn đẹp**.

**Đừng bỏ qua bước đo ở mục 4 vì "nhìn thấy mượt".** Chênh 300ms và chênh 1.200ms nhìn bằng mắt như nhau, mà một cái đạt còn một cái phải trả hàng.
