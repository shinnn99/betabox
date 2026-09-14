# Hướng Dẫn Kỹ Thuật: Kiến Trúc & Luồng Xử Lý Hệ Thống Camera Bắt Sự Kiện

Tài liệu này mô tả luồng xử lý và kiến trúc phần mềm tổng quát cho các hệ thống giám sát camera kết hợp nhận diện sự kiện (như quét mã vạch, nhận diện khuôn mặt...). Tài liệu tập trung vào logic cốt lõi, độc lập với ngôn ngữ lập trình, cơ sở dữ liệu hay framework giao diện.

## 1. Nguyên Tắc Thiết Kế Cốt Lõi

Hệ thống tuân theo mô hình **Tách biệt Trách nhiệm (Separation of Concerns)**:

*   **Backend (Server):** Chỉ tập trung vào việc **xử lý luồng video (stream)**. Công việc chính là lưu toàn bộ video thô xuống ổ cứng liên tục, cung cấp một luồng stream nhẹ để xem trực tiếp, và cung cấp API để cắt/ghép video dựa trên mốc thời gian. Server không xử lý các nghiệp vụ nhận diện (như mã QR) hay logic vòng đời sự kiện.
*   **Frontend (Client):** Tập trung vào **nghiệp vụ (business logic)**. Chịu trách nhiệm hiển thị stream, chạy thuật toán nhận diện (quét mã), quản lý vòng đời của sự kiện, và quyết định khi nào cần gọi Server để tạo ra một đoạn video thành phẩm.

---

## 2. Luồng Xử Lý Backend (Server-side)

### 2.1. Ghi Hình Liên Tục (Continuous Recording)
*   **Ghi trực tiếp (No Re-encode):** Để tối ưu tài nguyên khi xử lý nhiều camera, Server đọc luồng gốc (RTSP/RTMP) và lưu thẳng xuống bộ nhớ bằng chế độ sao chép luồng (stream copy) thay vì mã hóa lại.
*   **Chia nhỏ file (Segmentation):** Luồng video được cấu hình để tự động cắt nhỏ thành các đoạn (segment) có độ dài cố định. Tên mỗi file chứa mốc thời gian tạo. Việc này giúp tìm kiếm, trích xuất đoạn video cụ thể rất nhanh và tránh lỗi hỏng file lớn.
*   **Dọn dẹp tự động (Retention/Cleanup):** Một tiến trình chạy ngầm liên tục kiểm tra và xóa các file segment vượt quá thời hạn lưu trữ quy định để giải phóng không gian bộ nhớ.

### 2.2. Luồng Xem Trực Tiếp (Low-latency Live Stream)
*   Do stream gốc thường nặng và khó phát trên trình duyệt với độ trễ thấp, Server sẽ rẽ nhánh luồng gốc, chuyển mã (transcode) sang một định dạng nhẹ hơn (phù hợp giải mã trực tiếp trên trình duyệt bằng Javascript hoặc thẻ Video) và truyền qua giao thức thời gian thực (như WebSocket, WebRTC).

### 2.3. Cắt Ghép Video Theo Sự Kiện (Video Assembly)
*   Server cung cấp API nhận đầu vào là các mốc thời gian (bắt đầu, kết thúc) và danh sách camera cần trích xuất.
*   Thuật toán xử lý:
    1. Quét thư mục lưu trữ để tìm các file segment nằm trong khoảng thời gian được yêu cầu.
    2. Nối (concat) các file segment này lại với nhau.
    3. Nếu cần ghép nhiều camera vào một khung hình, áp dụng các bộ lọc ghép hình (chồng lớp, ghép ngang/dọc) của công cụ xử lý video.
    4. Cắt gọt (trim) chính xác phần thừa ở hai đầu để video có độ dài khớp đúng với khoảng thời gian yêu cầu.
    5. Trả file video thành phẩm về cho Client.

---

## 3. Luồng Xử Lý Frontend (Client-side)

### 3.1. Đồng Bộ Thời Gian (Time Synchronization)
*   Do đồng hồ máy khách và máy chủ thường có độ lệch, nếu Client sử dụng giờ hệ thống cục bộ để yêu cầu cắt video, kết quả sẽ bị sai lệch.
*   Ngay khi khởi tạo, Client phải gọi API máy chủ để tính toán độ lệch thời gian. Trong suốt quá trình vận hành, mọi mốc thời gian sự kiện do Client tạo ra đều phải được cộng/trừ độ lệch này để đồng bộ tuyệt đối với hệ thống file của Server.

### 3.2. Hiển Thị & Quét Nhận Diện (Vision Processing)
*   Client nhận luồng trực tiếp từ máy chủ và vẽ lên giao diện. Nếu có nhiều camera, Client có thể tự sắp xếp bố cục (như Picture-in-Picture) để tối ưu không gian hiển thị cho người dùng.
*   **Thuật toán quét tối ưu:** Để không làm treo trình duyệt, thuật toán nhận diện không chạy trên mọi khung hình. Client sẽ trích xuất khung hình theo chu kỳ (bỏ qua một số frame nhất định) và chỉ thực hiện thuật toán quét trên một vùng không gian được chỉ định sẵn (vùng thao tác), thay vì quét toàn bộ độ phân giải camera.

### 3.3. Quản Lý Vòng Đời Sự Kiện (Event State Machine)
*   Client quản lý vòng đời sự kiện thông qua các trạng thái (ví dụ: Chờ, Đang xử lý).
*   **Bắt đầu:** Khi phát hiện một đối tượng hoặc mã định danh hợp lệ và chưa từng xuất hiện:
    *   Chuyển trạng thái sang đang xử lý.
    *   Lưu lại mốc thời gian bắt đầu (đã đồng bộ offset).
    *   Khởi chạy bộ đếm thời gian an toàn (Timeout) nhằm giới hạn độ dài tối đa của một sự kiện để tránh lỗi sự kiện kéo dài vô tận.
*   **Kết thúc:** Quá trình kết thúc khi có hành động ngắt chủ động từ người dùng, khi phát hiện sự kiện mới thay thế, hoặc khi hết thời gian Timeout an toàn.
    *   Chốt mốc thời gian kết thúc.
    *   Đóng gói dữ liệu sự kiện (mã định danh, mốc thời gian bắt đầu, mốc thời gian kết thúc) và lưu trữ vào Cơ sở dữ liệu.
    *   Quay lại trạng thái chờ.

---

## 4. Xử Lý Bất Đồng Bộ & Lưu Trữ Đám Mây

Để duy trì hiệu năng cao và không cản trở thao tác liên tục của người dùng, việc tạo ra file video thành phẩm không diễn ra ngay lập tức khi sự kiện kết thúc.

*   Tại thời điểm kết thúc sự kiện, hệ thống chỉ lưu lại **siêu dữ liệu (metadata)** về thời gian và định danh trên Database.
*   Quá trình xử lý video được thực hiện **On-demand (Theo yêu cầu)**:
    1. Khi có tác vụ yêu cầu trích xuất video (do người dùng chủ động thao tác hoặc do một tiến trình đồng bộ chạy ngầm), Client gọi API cắt video của Server kèm theo mốc thời gian tương ứng.
    2. Server thực hiện thuật toán cắt ghép và trả về file thành phẩm.
    3. Client nhận file, sau đó khởi chạy tiến trình tải tệp này lên hệ thống Lưu trữ đám mây (Cloud Storage).
    4. Khi tải lên thành công, Cloud Storage trả về đường dẫn truy cập công khai.
    5. Hệ thống tiến hành cập nhật đường dẫn này vào bản ghi dữ liệu sự kiện tương ứng trong Database để lưu trữ lâu dài.
