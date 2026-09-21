# Luồng đơn đi và đơn hoàn

**Cập nhật:** 18/09/2026 · **Trạng thái:** thiết kế, chưa triển khai
**Tài liệu kỹ thuật đi kèm:** [HOAN-HANG-quay-video-don-hoan.md](HOAN-HANG-quay-video-don-hoan.md) (dữ liệu, các đợt triển khai, kiểm thử)

---

## 0. Tóm tắt

- Kho có hai việc cần quay video:
  - **đóng hàng gửi đi** (đơn đi);
  - **mở kiện hàng hoàn về** (đơn hoàn).
- Cả hai dùng **chung bàn, chung camera, chung ca làm việc**. Mỗi bàn ở một trong hai **chế độ**: ĐÓNG HÀNG hoặc NHẬN HOÀN. Chế độ quyết định mã quét vào sẽ thành đơn đi hay đơn hoàn.
- **Đơn đi** được đếm vào số đơn đóng của nhân viên. **Đơn hoàn không bao giờ được đếm.**
- Hệ thống **không xử lý tiền bạc**. Nó chỉ đếm đơn, quay video, giữ bằng chứng và nhắc hạn.
- Mọi trạng thái đều **tự kết thúc** sau một thời gian cố định, nên không có đơn nào treo mãi và không có video nào lặng lẽ mất.

---

## 1. Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **Đơn đi** | Một lần quét mã vận đơn khi đóng hàng gửi khách |
| **Đơn hoàn / kiện hoàn** | Một lần quét mã trên kiện hàng quay về kho |
| **Hoàn do giao thất bại** | Kiện không giao được, quay về với **đúng mã vận đơn cũ** |
| **Khách trả hàng** | Khách yêu cầu trả hàng, sàn cấp **mã vận đơn mới**; có khi khách **viết tay** mã lên hộp |
| **Ca** | Khoảng thời gian một nhân viên làm việc tại một bàn, mở và đóng bằng QR nhân viên |
| **Chế độ bàn** | ĐÓNG HÀNG hoặc NHẬN HOÀN |
| **Bàn chuyên hoàn** | Bàn được đặt mặc định ở chế độ NHẬN HOÀN |
| **Thẻ điều khiển** | Thẻ QR in sẵn dán ở bàn: chuyển chế độ, báo kết quả kiểm hàng, kết thúc kiện |
| **Segment** | Đoạn video 60 giây camera ghi liên tục trên máy kho |
| **Clip** | Video của một đơn, được cắt từ các segment rồi tải lên cloud để xem |
| **Hồ sơ** | Bản ghi theo dõi một kiện hoàn có vấn đề hoặc chưa được kiểm, có hạn xử lý |
| **Lưới an toàn** | Cơ chế tự nhận ra kiện hoàn bị quét nhầm ở bàn đang đóng hàng |

---

## 2. Các mốc thời gian

Tất cả thời gian của hệ thống nằm trong bảng này. Cột "Theo" cho biết ai đặt con số.

| Mốc | Giá trị | Theo | Ghi chú |
|---|---|---|---|
| Đơn đi tự dừng nếu không ai quét tiếp | **180 giây** mặc định | hệ thống hiện có | Chủ kho chỉnh được; kho Betacom Demo đang đặt 600 giây |
| **Kiện hoàn tự dừng** | **5 phút** | **chủ dự án** | |
| **Bàn tự về chế độ ĐÓNG HÀNG** khi không thao tác | **5 phút** | **chủ dự án** | Không áp dụng cho bàn chuyên hoàn |
| Video bắt đầu trước lúc quét | 5 giây | hệ thống hiện có | |
| Video kéo dài sau lúc kết thúc | 5 giây | hệ thống hiện có | |
| Clip đơn đi dài tối đa | 180 giây | hệ thống hiện có | |
| Clip kiện hoàn dài tối đa | 5 phút + 10 giây đệm | theo mốc tự dừng | |
| Ghi hình tiếp sau khi ca cuối của bàn đóng | 60 giây | hệ thống hiện có | Đủ đoạn đệm cho đơn cuối |
| Ca tự đóng nếu quên check-out | 12 giờ | hệ thống hiện có | |
| **Segment đơn đi lưu trên máy kho** | 35 ngày | cấu hình kho hiện tại | Chủ kho chỉnh trên dashboard |
| **Segment kiện hoàn lưu trên máy kho** | **7 ngày** | **chủ dự án** | |
| **Clip trên cloud (Supabase)** | **72 giờ** | **chủ dự án** | Cả đơn đi và đơn hoàn |
| Hạn xử lý hồ sơ kiện hoàn | 7 ngày | theo hạn lưu segment hoàn | Không được dài hơn hạn lưu |
| Lưới an toàn nhìn lại bao xa | 60 ngày | thiết kế | Mã đã đóng trong 60 ngày gần nhất |
| Script xoá segment trên máy kho | 03:00 **hằng ngày** | thiết kế | Hiện đang chạy hằng tuần; phải đổi để giữ đúng 7 ngày |

---

## 3. Phần dùng chung cho cả hai loại đơn

### 3.1 Hệ thống phân loại một lượt quét

Mọi lượt quét, dù từ súng quét, camera đọc QR hay ô nhập tay, đều đi qua **cùng một chuỗi kiểm tra theo thứ tự**. Dừng ở bước nào thì kết thúc ở bước đó.

| Bước | Kiểm tra | Nếu không đạt |
|---|---|---|
| 1 | Nguồn quét có đúng nguồn bàn đang dùng không (súng hay camera) | Bỏ qua. Màn hình bàn báo bàn đang quét bằng nguồn nào |
| 2 | Có phải **thẻ điều khiển** không | → xử lý thẻ (mục 3.3 và 5.3) |
| 3 | Có phải **QR nhân viên** không | → mở / đóng / đổi ca (mục 3.2) |
| 4 | Máy quét đã gắn vào bàn chưa | Kết thúc, báo "máy quét chưa gắn bàn" lên Lark |
| 5 | Mã có hợp lệ không (không rỗng, không lỗi ký tự) | Kết thúc, ghi "mã không hợp lệ" |
| 6 | Bàn có ca đang mở không | Kết thúc. Loa: "Chưa mở ca nên không quay được" |
| 7 | Bàn đang ở chế độ nào | ĐÓNG HÀNG → luồng đơn đi (mục 4). NHẬN HOÀN → luồng đơn hoàn (mục 5) |

- Thứ tự này đảm bảo thẻ điều khiển và QR nhân viên **không bao giờ** bị hiểu nhầm thành mã vận đơn.
- Các lượt dừng ở bước 1, 4, 5, 6 **không tạo đơn, không đếm, không có video riêng**.
- Nếu máy kho mất mạng, lượt quét nằm trong hàng đợi trên máy và được gửi lại khi có mạng. Hệ thống xử lý theo **giờ quét gốc**, nên thứ tự đơn không bị đảo.

### 3.2 Ca làm việc và ghi hình

**Camera ghi theo ca của bàn, không theo từng đơn.** Trong suốt ca, camera ghi liên tục thành các segment 60 giây. Video của từng đơn, đi hay hoàn, được cắt ra từ các segment đó. Vì vậy chuyển qua lại giữa đóng hàng và nhận hoàn **không làm đứt video**.

| Việc xảy ra | Ghi hình | Đơn đang mở của bàn |
|---|---|---|
| Nhân viên quét QR, ca **đầu tiên** của bàn mở | Bật ghi **mọi** camera của bàn (toàn cảnh + QR) | — |
| Nhân viên khác quét QR vào bàn | Ghi tiếp, không đứt | — |
| Nhân viên quét QR lần hai, ca **cuối cùng** của bàn đóng | Dừng ghi sau **60 giây** | Đơn đi đang mở: đóng lại. Kiện hoàn đang mở: đóng với "chưa kiểm" |
| Có ca mở lại trong 60 giây đó | Huỷ lệnh dừng, ghi tiếp không đứt | — |
| Quên check-out | Ca tự đóng sau **12 giờ** | Như đóng ca |
| Camera rớt mạng lúc mở ca | Agent tự thử lại; tự tìm lại camera theo địa chỉ MAC nếu IP đổi | Màn hình bàn cảnh báo "Camera chưa ghi" |

Bàn ở chế độ NHẬN HOÀN **cũng phải có ca**. Không có ca thì không có ghi hình.

### 3.3 Chế độ của bàn

Mỗi bàn luôn ở **đúng một** chế độ.

| Đang ở | Việc xảy ra | Chuyển sang | Kèm theo |
|---|---|---|---|
| — | Tạo bàn | Chế độ mặc định của bàn | Mặc định là ĐÓNG HÀNG; bàn chuyên hoàn mặc định NHẬN HOÀN |
| ĐÓNG HÀNG | Quét thẻ **HOÀN** | NHẬN HOÀN | Đơn đi đang mở được đóng lại |
| NHẬN HOÀN | Quét thẻ **ĐÓNG HÀNG** | ĐÓNG HÀNG | Kiện hoàn đang mở đóng với "chưa kiểm" |
| NHẬN HOÀN (bàn không chuyên hoàn) | **5 phút** không thao tác | ĐÓNG HÀNG (tự động) | Như trên. Loa: "Đã về chế độ đóng hàng" |
| Bất kỳ | Ca cuối của bàn đóng | Chế độ mặc định của bàn | Đóng mọi đơn đang mở |
| Bất kỳ | Chủ kho đổi chế độ mặc định trên Thiết bị kho | Chế độ mặc định mới | Như quét thẻ tương ứng |

- Màn hình bàn **luôn hiện chế độ hiện tại**; chế độ NHẬN HOÀN có **nền cam**.
- **Bàn chuyên hoàn** không tự về chế độ đóng hàng.
- **Tính "không thao tác"** từ lượt quét hoặc thẻ gần nhất ở bàn. Kiện hoàn mở mà để yên thì sau 5 phút **hai việc xảy ra cùng lúc**, luôn theo thứ tự: (1) kiện tự dừng, ghi "chưa kiểm" và lý do *quá thời gian*; (2) bàn tự về ĐÓNG HÀNG. Nhờ vậy kiện luôn đóng trước khi bàn đổi chế độ, không bao giờ bị ghi hai lý do.

---

## 4. Luồng ĐƠN ĐI

### 4.1 Nhân viên làm gì

1. Quét QR nhân viên để mở ca, nếu chưa mở.
2. Bàn đang ở chế độ **ĐÓNG HÀNG**.
3. Quét mã vận đơn → loa báo "Bắt đầu quay video".
4. Đóng gói trước camera.
5. Quét mã đơn tiếp theo. Đơn trước tự kết thúc.
6. Hết ca: quét QR nhân viên lần nữa để đóng ca.

### 4.2 Hệ thống xử lý mã vận đơn ở chế độ ĐÓNG HÀNG

| Tình huống của mã | Hệ thống làm gì | Đếm vào số đơn | Đơn đang mở của bàn | Loa |
|---|---|---|---|---|
| Mã chưa từng đóng | Tạo **đơn đi**, bắt đầu tính giờ; ghi lại camera toàn cảnh và camera QR của bàn vào đơn | **Có** | Đóng lại | "Bắt đầu quay video · mã" |
| Mã đã đóng **hôm nay** | Ghi là **quét trùng**, không tạo đơn mới | Không | Giữ nguyên | "Mã đã quét · nếu là hàng hoàn, quét thẻ HOÀN" |
| Mã đã đóng **ngày khác** trong 60 ngày (**lưới an toàn**, mới) | Tạo **kiện hoàn nghi ngờ**, đóng ngay với "chưa kiểm", mở hồ sơ | **Không** | Giữ nguyên | "Mã đã đóng ngày dd/mm · quét thẻ HOÀN rồi quét lại" |

Dòng thứ ba là thay đổi quan trọng nhất. **Hiện nay** quét lại một mã vào ngày khác tạo đơn mới và **đếm thành đơn đóng lần hai**; sau thay đổi thì không còn.

### 4.3 Sáu cách một đơn đi kết thúc

| # | Cách kết thúc | Ai / cái gì kích hoạt | Thời lượng đơn được tính |
|---|---|---|---|
| 1 | Quét mã đơn tiếp theo | Nhân viên | Tới lúc quét mã tiếp |
| 2 | Quét mã tiếp theo khi đơn đã quá thời gian tối đa | Nhân viên | Đúng bằng thời gian tối đa |
| 3 | **Quá thời gian tối đa mà không ai quét** | **Hệ thống tự dừng** | Đúng bằng thời gian tối đa; loa báo "đã tự dừng" |
| 4 | Đóng ca | Nhân viên / tự đóng sau 12 giờ | Tới lúc đóng ca |
| 5 | Đóng ca sau một khoảng quá dài (quên check-out) | Hệ thống | Ước lượng theo cấu hình kho |
| 6 | Quét thẻ HOÀN (chuyển chế độ, mới) | Nhân viên | Tới lúc quét thẻ |

- **Lối ra tự động:** cách 3. Kể cả khi màn hình bàn tắt, việc tự dừng vẫn chạy nhờ nhịp báo sống của agent. **Không đơn đi nào mở quá thời gian tối đa.**
- Trong lúc đơn mở, màn hình bàn đếm ngược và báo "Sắp hết thời gian" khi còn 30 giây.

### 4.4 Video đơn đi

| Giai đoạn | Mô tả |
|---|---|
| Đơn đang mở | Chưa cắt được video |
| Đơn đã đóng | Video **chưa cắt**. Chỉ cắt khi có người mở xem |
| Có người mở, máy kho online | Agent cắt, ghép 2 góc, tải lên. Hiện "Đang xử lý" |
| Có người mở, máy kho offline | Hiện "Chờ máy kho online"; tự cắt khi máy online lại |
| Cắt lỗi | Hiện lý do và nút **Thử lại** |
| Sẵn sàng | Xem và tải trên cloud trong **72 giờ** |
| Quá 72 giờ | Clip trên cloud bị xoá. Mở lại thì cắt lại từ segment |
| Quá **35 ngày** | Segment trên máy kho đã bị xoá. Hiện "Quá hạn lưu trữ" (trạng thái cuối) |

**Bố cục video:**
- khung chính 1920×1080 là camera toàn cảnh;
- ô **đứng dọc** 360×640 ở góc trên phải là camera QR;
- dải thông tin ở đáy: mã, kho, bàn, nhân viên, giờ quét.

Bàn chỉ có một camera thì xuất **một góc**, không ghép camera với chính nó.

### 4.5 Đếm vào số đơn đóng

- **Được đếm:** mỗi đơn đi hợp lệ, kể cả đơn phải tự dừng hay ước lượng thời gian (nhân viên vẫn đã quét).
- **Không được đếm:** quét trùng, chưa mở ca, máy quét chưa gắn bàn, mã không hợp lệ, và **mọi kiện hoàn**.
- Mọi báo cáo (báo cáo nhân viên, tổng quan, biểu đồ sản lượng, tin nhắn Lark) đọc **cùng một nguồn** nên không bao giờ lệch nhau. Hiện có 4 nơi đếm theo 2 quy tắc khác nhau; sẽ gom về một.

---

## 5. Luồng ĐƠN HOÀN

### 5.1 Nhân viên làm gì

1. Mở ca (quét QR nhân viên), nếu chưa mở.
2. Đưa bàn về chế độ **NHẬN HOÀN**: quét thẻ **HOÀN**, hoặc làm ở bàn chuyên hoàn.
3. Quét mã trên kiện. Mã viết tay thì gõ vào ô **Nhập tay** trên màn hình bàn.
4. Mở kiện trước camera, đưa sản phẩm và tem nhãn qua camera.
5. Quét **một thẻ kết quả**: **OK**, **HỎNG**, **THIẾU** hoặc **TRÁO**.
6. Quét kiện tiếp theo, hoặc quét thẻ **ĐÓNG HÀNG** để quay lại đóng hàng.

### 5.2 Hệ thống xử lý lượt quét ở chế độ NHẬN HOÀN

| Quét gì | Hệ thống làm gì | Loa |
|---|---|---|
| Mã trùng một **đơn đi** đã có trong hệ thống (hoàn do giao thất bại) | Mở **kiện hoàn**, nối với đơn đi cùng mã để sau này xem hai video cạnh nhau | "Đơn hoàn · đã đóng ngày dd/mm · nhân viên …" |
| Mã chưa có trong hệ thống (thường là khách trả hàng) | Mở **kiện hoàn mới** | "Đơn hoàn mới · mở hàng trước camera" |
| Mã của kiện **đã ghi hoàn** trước đó | Không mở kiện mới, ghi là quét trùng | "Kiện này đã ghi hoàn lúc hh:mm" |
| Mã từng vào **lưới an toàn** (mục 4.2) | Chuyển chính kiện nghi ngờ đó thành kiện hoàn đang mở, không tạo bản ghi thứ hai; huỷ hồ sơ cũ của nó | Như dòng đầu |
| Thẻ kết quả khi đang có kiện mở | Đóng kiện với kết quả đó (mục 5.3) | Đọc kết quả |
| Thẻ kết quả khi **không** có kiện mở | Bỏ qua | "Chưa có kiện hoàn nào đang mở" |

- Mở một kiện mới khi đang có kiện mở: kiện cũ được **đóng trước** với "chưa kiểm".
- Kiện hoàn **không bao giờ** đóng hay làm thay đổi thời gian của một đơn đi.

### 5.3 Tám cách một kiện hoàn kết thúc

| # | Cách kết thúc | Ai / cái gì kích hoạt | Kết quả ghi | Tạo hồ sơ |
|---|---|---|---|---|
| 1 | Quét thẻ **OK** | Nhân viên, hàng ổn | OK | Không |
| 2 | Quét thẻ **HỎNG / THIẾU / TRÁO** | Nhân viên, phát hiện vấn đề | Hỏng / Thiếu / Tráo | **Có** |
| 3 | Quét thẻ **KẾT THÚC** | Nhân viên kết thúc nhưng không chọn kết quả | Chưa kiểm | **Có** |
| 4 | Quét mã **kiện tiếp theo** | Nhân viên quên quét thẻ kết quả | Chưa kiểm | **Có** |
| 5 | **Đổi chế độ bàn** | Thẻ ĐÓNG HÀNG, hoặc tự về sau 5 phút không thao tác | Chưa kiểm | **Có** |
| 6 | **Đóng ca** | Ca cuối của bàn kết thúc | Chưa kiểm | **Có** |
| 7 | **Quá 5 phút** | **Hệ thống tự dừng** | Chưa kiểm | **Có** |
| 8 | **Lưới an toàn** | Mã đã đóng ngày trước bị quét ở bàn đang ĐÓNG HÀNG; hệ thống tạo kiện và đóng ngay | Chưa kiểm | **Có** |

- Cách **1–2**: nhân viên chủ động chọn kết quả, là cách đóng bình thường.
- Cách **3–7**: lối thoát để kiện không bao giờ treo. Cách 7 là **lối ra tự động**: không kiện hoàn nào mở quá **5 phút**.
- Cách **8**: lưới an toàn ở bàn đóng hàng.
- Mọi kết quả **"Chưa kiểm"** đều tạo hồ sơ ghi rõ "Nhân viên chưa xác nhận kết quả". Chủ kho xem video rồi quyết, nên **quên thao tác không làm mất bằng chứng**.
- Màn hình bàn đếm ngược 5 phút trong lúc kiện mở.

### 5.4 Hồ sơ kiện hoàn

Hồ sơ theo dõi bằng chứng và hạn, **không có số tiền**.

| Trạng thái | Nghĩa | Chuyển tiếp |
|---|---|---|
| **Cần xử lý** | Kiện có vấn đề hoặc chưa kiểm | Chủ kho bấm **Đã khiếu nại** (ghi mã khiếu nại sàn nếu muốn) hoặc **Không cần**. Hết hạn 7 ngày mà chưa bấm → **Hết hạn** (tự động) |
| **Đã khiếu nại** | Đã dùng video làm bằng chứng | Trạng thái cuối |
| **Không cần** | Chủ kho xem và thấy không cần làm gì | Trạng thái cuối |
| **Hết hạn** | Quá 7 ngày không xử lý | Trạng thái cuối |

- Lark báo khi hồ sơ được tạo và khi còn **24 giờ** trước hạn.
- Trang **Hàng hoàn** liệt kê hồ sơ, sắp theo hạn gần nhất trước.

### 5.5 Video kiện hoàn và thời gian lưu

| Giai đoạn | Mô tả |
|---|---|
| Kiện kết quả **OK** | Chưa cắt; chỉ cắt khi có người mở |
| Kiện **có vấn đề hoặc chưa kiểm** | **Cắt ngay**, không chờ ai mở, để bằng chứng sẵn trước hạn |
| Máy kho offline lúc cần cắt | Hồ sơ hiện "Chờ máy kho online"; tự cắt khi máy online lại |
| Cắt lỗi | Hiện lý do và nút **Thử lại** |
| Sẵn sàng | Xem và tải trên cloud trong **72 giờ** |
| Quá 72 giờ | Clip trên cloud bị xoá; mở lại thì cắt lại từ segment |
| Quá **7 ngày** | Segment đã bị xoá. Hiện "Đã quá 7 ngày lưu video hàng hoàn" (trạng thái cuối) |

- **Bố cục** giống đơn đi: toàn cảnh + ô QR đứng dọc. Clip tối đa 5 phút + 10 giây đệm.
- Kiện hoàn do giao thất bại có **video mở hoàn đặt cạnh video đóng đi** của cùng mã, tải cả hai bằng một nút.
- **Chỉ segment thuần hàng hoàn** mới xoá sau 7 ngày. Segment nào dính tới một đơn đi, hoặc không chắc chắn, được giữ như đơn đi (35 ngày). Như vậy không bao giờ xoá nhầm bằng chứng đơn đi.

### 5.6 Đếm vào số đơn đóng

**Không.** Kiện hoàn chỉ hiện ở trang Hàng hoàn, không có trong báo cáo nhân viên.

---

## 6. So sánh hai luồng

| | Đơn đi | Đơn hoàn |
|---|---|---|
| Chế độ bàn | ĐÓNG HÀNG | NHẬN HOÀN |
| Mã | Mã vận đơn gửi đi | Giao thất bại: mã cũ · Khách trả: mã mới, có thể viết tay |
| Quét trùng | Cùng ngày: báo trùng · Ngày khác: lưới an toàn chuyển thành kiện hoàn | Báo "đã ghi hoàn" |
| Kết thúc bình thường | Quét mã tiếp theo | Quét thẻ kết quả |
| Tự dừng sau | 180 giây mặc định | **5 phút** |
| Kết quả kiểm | Không có | OK / Hỏng / Thiếu / Tráo / Chưa kiểm |
| Cắt video | Khi có người mở | Khi có người mở; **cắt ngay** nếu có vấn đề |
| Clip dài tối đa | 180 giây | 5 phút + đệm |
| Lưu segment trên máy kho | 35 ngày | **7 ngày** |
| Lưu clip trên cloud | 72 giờ | 72 giờ |
| Hồ sơ | Không | Có, hạn 7 ngày |
| Đếm vào số đơn đóng | **Có** | **Không** |

---

## 7. Bảng thắt luồng

Mỗi dòng là một trạng thái có thể kéo dài. Cột **"Nếu không ai làm gì"** cho biết nó tự kết thúc thế nào.

| Trạng thái | Người kết thúc bằng cách | Nếu không ai làm gì | Tối đa | Hiện ở đâu |
|---|---|---|---|---|
| Ca đang mở | Quét QR check-out | Tự đóng | 12 giờ | Màn hình bàn, Giám sát kho |
| Ghi hình sau ca cuối | — | Tự dừng | 60 giây | Thiết bị kho |
| Bàn (không chuyên hoàn) ở NHẬN HOÀN | Thẻ ĐÓNG HÀNG | Tự về ĐÓNG HÀNG | 5 phút rảnh | Nhãn cam trên màn hình bàn |
| Đơn đi đang mở | Quét mã tiếp / đóng ca / thẻ HOÀN | Tự dừng | 180 giây (mặc định) | Đếm ngược trên màn hình bàn |
| **Kiện hoàn đang mở** | Thẻ kết quả / thẻ KẾT THÚC / quét kiện tiếp | **Tự dừng, ghi "chưa kiểm"** | **5 phút** | Đếm ngược trên màn hình bàn |
| Hồ sơ cần xử lý | Đã khiếu nại / Không cần | Tự chuyển Hết hạn | 7 ngày | Trang Hàng hoàn, Lark |
| Video chờ máy kho | — | Tự cắt khi máy online; quá hạn lưu → "Quá hạn lưu trữ" | 7 / 35 ngày | Nút xem video, hồ sơ |
| Clip trên cloud | — | Tự xoá (cắt lại khi mở) | 72 giờ | Nút xem video |
| Segment trên máy kho | — | Script xoá hằng ngày | 7 ngày (hoàn) / 35 ngày (đi) | — |
| Lượt quét chờ mạng | — | Tự gửi khi có mạng | tới khi có mạng | Giám sát kho: "Kho đang offline" |

**Chỉ có một trạng thái cuối cần người bấm tiếp: video lỗi.** Nó hiện lý do kèm nút Thử lại, và quá hạn lưu thì tự chuyển sang "Quá hạn lưu trữ".

---

## 8. Tình huống bất thường

| Tình huống | Hệ thống xử lý |
|---|---|
| Quét khi chưa mở ca | Không tạo đơn. Loa: "Chưa mở ca nên không quay được" |
| Máy quét chưa gắn bàn | Không tạo đơn; báo Lark |
| Quét súng khi bàn đặt đọc mã bằng camera (hoặc ngược lại) | Bỏ qua; màn hình báo nguồn quét đang dùng |
| Camera rớt mạng giữa đơn | Agent tự nối lại; clip thiếu đoạn thì ghi rõ "thiếu N giây" |
| Máy kho mất mạng | Lượt quét chờ trong hàng đợi, camera vẫn ghi trên máy; cắt clip khi có mạng |
| Nhân viên quên chuyển về ĐÓNG HÀNG | Bàn tự về sau 5 phút rảnh; đơn đi sau đó đếm bình thường |
| Nhân viên quét đơn đi ở chế độ NHẬN HOÀN | Không được đếm, nên không có lợi để cố tình; chủ kho thấy kiện lạ ở trang Hàng hoàn |
| Kiện giao thất bại về **cùng ngày** với ngày đóng, quét ở bàn ĐÓNG HÀNG | Báo trùng và gợi ý quét thẻ HOÀN |
| Kiện khách trả chỉ có mã viết tay | Gõ vào ô Nhập tay (chỉ hiện ở chế độ NHẬN HOÀN) |
| Hai máy chạy cùng mã agent | Chỉ một máy được nhận lệnh; máy kia ghi rõ lỗi trùng mã |

---

## 9. Giải pháp chốt: tham khảo Dohana, dựa trên hệ thống hiện tại

**Phạm vi:** chỉ luồng hoàn hàng, không có tính năng tiền bạc. **Thời gian** theo chủ dự án: kiện hoàn tự dừng sau 5 phút, segment hoàn lưu 7 ngày, clip cloud 72 giờ.

### 9.1 Lấy gì từ Dohana

Dohana ("Đóng Hàng Nhanh") là đối thủ gần nhất: cũng dùng 2 camera (toàn cảnh + soi mã vận đơn) và có chế độ quay hoàn riêng. Họ không công bố tài liệu thao tác chi tiết, nên chỉ đối chiếu được tính năng.

| Dohana có | Ta làm |
|---|---|
| Chế độ riêng **"Ghi hình mở hàng hoàn"** | **Có**: chế độ NHẬN HOÀN của bàn |
| Tra video theo mã vận đơn, đủ chuẩn khiếu nại sàn | **Có sẵn**: tìm theo mã; clip có dải thông tin |
| Theo dõi trạng thái từng đơn hoàn | **Có**: hồ sơ Cần xử lý → Đã khiếu nại / Không cần / Hết hạn |
| Video hoàn tối đa 20 phút | **Không theo**: chủ dự án chốt **5 phút** |
| Lưu video 25 ngày | **Không theo**: 7 ngày segment, 72 giờ cloud |
| Tỷ lệ thành công, số tiền thu hồi | **Không làm**: hệ thống chưa xử lý tiền |
| Bàn giao shipper, đơn huỷ ngang, quay trước khi có mã | **Không làm**: ngoài phạm vi luồng hoàn |

### 9.2 Dùng lại gì của hệ thống hiện tại

| Đang có | Dùng cho hàng hoàn |
|---|---|
| Ca làm việc + ghi hình liên tục theo ca, 2 camera theo bàn | Quay kiện hoàn bằng chính camera của bàn; không cần phần cứng mới |
| Đọc QR bằng camera, súng quét, nhập tay | Quét mã kiện, thẻ chế độ, thẻ kết quả, mã viết tay |
| Bảng đơn quét hiện có | Thêm loại "đi / hoàn" thay vì làm bảng mới |
| Cắt, ghép 2 góc, tải lên, xem theo mã | Dùng nguyên; thêm trần 5 phút và cắt ngay khi có vấn đề |
| Tự dừng đơn quá giờ | Thêm nhánh cho kiện hoàn |
| Màn hình bàn có loa và đếm ngược | Thêm nhãn chế độ, đếm ngược 5 phút, ô nhập tay |
| Script xoá segment trên máy kho | Thêm bước xoá segment hoàn sau 7 ngày, chạy hằng ngày |

### 9.3 Hơn Dohana ở đâu (theo những gì họ công bố)

- **Lưới an toàn:** kiện hoàn quét nhầm ở bàn đóng hàng không bị đếm thành đơn đóng mới, cũng không cắt ngang video đơn đang đóng.
- **Quên thao tác không mất bằng chứng:** không quét thẻ kết quả vẫn có hồ sơ "chưa kiểm".
- **Video đóng đi và video mở hoàn của cùng một mã đặt cạnh nhau**, vì cả hai nằm chung hệ thống.
- **Cắt video ngay** khi kiện có vấn đề.

---

## 10. Nguồn

- **Mã hàng hoàn:**
  - [Shopee: phương thức gửi hàng hoàn trả](https://help.shopee.vn/portal/4/article/189477-[Tr%E1%BA%A3-h%C3%A0ng/-Ho%C3%A0n-ti%E1%BB%81n]-C%C3%A1c-ph%C6%B0%C6%A1ng-th%E1%BB%A9c-g%E1%BB%ADi-h%C3%A0ng-ho%C3%A0n-tr%E1%BA%A3-v%C3%A0-ph%C3%AD-ho%C3%A0n-tr%E1%BA%A3): mã hoàn do Shopee cấp, dán phiếu hoặc viết tay.
  - [FPT Shop](https://fptshop.com.vn/tin-tuc/thu-thuat/huong-dan-cach-tra-hang-shopee-176088): mã trả hàng khác mã gửi đi.
  - [TikTok Shop Seller Center](https://seller-sg.tiktok.com/university/essay?knowledge_id=3600843980211970&lang=en) và [ShipBots](https://www.shipbots.com/post/tiktok-shop-returns): nhãn hoàn có mã riêng. Đây là tài liệu khu vực/quốc tế, cần xác minh bằng một kiện hoàn thật ở Việt Nam.
  - [Tramavandon](https://tramavandon.com/blog/don-bi-giao-that-bai-hoan-ve-nguyen-nhan-va-cach-xu-ly-nhanh): giao thất bại tra cứu trên cùng mã, trạng thái "đang chuyển hoàn".
- **Bằng chứng khiếu nại:**
  - [GHN](https://ghn.vn/blogs/tip-ban-hang/giao-hang-khong-thanh-cong-tren-shopee-co-giao-lai-khong): quay video kiện hoàn ngay khi nhận.
  - [Effitrack](https://effitrack.me/trao-hang-shopee-cach-shop-xu-ly-de-khong-mat-tien/): video đóng gói và video mở hoàn là bằng chứng chính.
- **Dohana:** [camera.dohana.vn](https://camera.dohana.vn/), [videodonghang.com](https://videodonghang.com/), [donghangnhanh.vn](https://donghangnhanh.vn/en).
