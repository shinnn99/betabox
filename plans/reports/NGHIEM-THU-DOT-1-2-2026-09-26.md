# Nghiệm thu đợt 1 + đợt 2 — kế hoạch Vận hành nhiều kho

**Ngày:** 26/09/2026
**Kế hoạch:** `plans/active/VAN-HANH-NHIEU-KHO.md`
**Chủ dự án yêu cầu:** *"tự kiểm thử những gì đã làm xem có đúng yêu cầu ban đầu đề ra không, phải pass hết các loại kiểm thử rồi mới chuyển sang làm đợt tiếp theo"*

**Kết luận:** mười lớp kiểm thử — **cả mười lớp đạt**. Lớp 6 ban đầu đỏ một bài do đụng cổng với dịch vụ agent trên máy lập trình; chủ dự án dừng dịch vụ và chạy lại: **228/228**. Còn **một việc mở** ở phía vận hành, ghi ở cuối.

---

## Mười lớp kiểm thử

| # | Lớp | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | `npx tsc --noEmit` (đúng lệnh CI) | ✅ | không lỗi |
| 2 | `tsc -p tsconfig.tests.json` | ✅ | không lỗi |
| 3 | `pnpm test` | ✅ **652/652** | |
| 4 | Lint toàn repo | ✅ **0 lỗi, 0 cảnh báo trên dòng mới viết** | 16 lỗi + 4 cảnh báo còn lại đều **có từ trước** — xác nhận bằng `git diff` + `git blame` từng dòng, không đoán |
| 5 | `npm run build` + 4 script canh trước build | ✅ thoát mã 0 | changelog, URL ký, route ghi truyền `Request`, client ghi qua `apiFetch` đều qua. Chạy **hai lần** — lần hai sau khi tách thành phần |
| 6 | Agent: `tsc` + test | ✅ `tsc` sạch, test **228/228** | Lần đầu 227/228: bài smoke MediaMTX đụng cổng 8554 với dịch vụ BetacomAgent cài trên máy lập trình — **không phải do mã** (đợt 1–2 không đụng agent). Tôi chạy lại đúng phép thử trên cổng trống: đạt, 0 dòng lỗi. Chủ dự án dừng dịch vụ (cmd quyền quản trị), chạy `npm test`: **228/228**, rồi bật lại dịch vụ |
| 7 | Chạy thật trên database production | ✅ | Xem mục dưới |
| 8 | Gọi HTTP thật vào API platform | ✅ **11/11** | Xem mục dưới |
| 9 | Dựng giao diện tab Cấu hình với dữ liệu thật | ✅ **12/12** | Xem mục dưới |
| 10 | Đối chiếu yêu cầu gốc | ✅ phần đợt 1–2 | Xem mục cuối |

---

## Lớp 7 — chạy thật trên production, không ghi gì

**Đợt 1, nhánh im lặng:** `runSystemChecks` trên production → mục Cấu hình **ok**, *"1/1 tổ chức đủ cấu hình"*.

**Đợt 1, đủ vòng:** trước đó mục báo **warn** vì Đại Kim thiếu hạn lưu hàng hoàn → 10:56:42 (giờ VN) `betacomagency@gmail.com` điền 7 qua giao diện (có dòng audit) → mục **tự** chuyển ok. Không ai tắt tay.

**Đợt 1, nhánh báo lỗi:** Đại Kim đang ok nên phải chứng minh riêng. Dựng phạm vi theo dõi **trong bộ nhớ** gồm cả tổ chức Betacom (đang có giá trị bị kẹp thật) rồi chạy đúng `checkConfiguration`:
> **[warn] Betacom** — *Thời gian lưu video hàng hoàn: Chưa đặt — đang dùng mặc định 7 ngày. Kho KHO_HN: thời gian tối đa một đơn đặt 600s nhưng hệ thống dùng 180s…*
> **Cần làm:** *Vào Cấu hình kho → ô Số ngày giữ video hàng hoàn, điền số ngày. Hạ về 180s cho khớp, hoặc chấp nhận hai tầng khác nhau…*

Cờ `monitoring_enabled` trên database kiểm lại sau khi chạy: **y nguyên**.

**Đợt 2:** phép giải trên dữ liệu thật của cả hai tổ chức — KHO_HN *đặt 600 · dùng 180 · bị kẹp*; BKDK *kiện hoàn 300s, clip chỉ phủ 175s đầu*.

## Lớp 8 — HTTP thật vào `/api/platform/orgs/[id]`

| Ca | Cách | Kết quả |
|---|---|---|
| 1. Không đăng nhập | gọi thẳng | ✅ HTTP 401, không lộ dữ liệu cấu hình |
| 2. Tài khoản **khách** | tạo tài khoản + tổ chức tạm theo khuôn `test-gate1-platform-admins-add.ts`, đăng nhập thật | ✅ HTTP **403 `forbidden_platform_only`**, không lộ cấu hình kho người khác. **Dọn sạch, tự kiểm lại: 0 tổ chức, 0 tài khoản tạm còn sót** |
| 3. Quản trị platform | gọi thẳng hàm xử lý route, **chỉ giả lập bước xác thực** — cố ý không tạo tài khoản quản trị platform trên production | ✅ **5/5**: bảng cấu hình khớp **từng dòng** với phép giải cho cả hai tổ chức; tiêu chí *600 / 180 / bị kẹp* đúng; không rơi trường cũ nào; tổ chức không tồn tại trả 404 |

## Lớp 9 — dựng giao diện

Tách tab Cấu hình ra `src/components/platform/ConfigParamsPanel.tsx` — Next.js không cho file trang xuất thêm thành phần, nên để lọt trong đó thì không kiểm được. Dựng bằng `renderToStaticMarkup` với dữ liệu production, **12/12**:
- có hai cột *Đặt* / *Thực dùng*, bảng tổ chức và bảng từng kho
- dòng KHO_HN hiện *600s / 180s*, chip **Bị kẹp**, tô màu, kèm lý do
- ô trống hiện *—* và chip **Mặc định**
- dòng đặt đúng thì **không** tô màu
- hệ quả *"125s cuối không có video"* hiện ở Đại Kim
- không lọt `undefined` / `NaN` / `[object Object]`

---

## Lớp 10 — đối chiếu yêu cầu

### Tiêu chí nghiệm thu trong kế hoạch

| Đợt | Tiêu chí | Đạt |
|---|---|---|
| 1 | Trang Tình trạng hiện đúng mục đang thiếu cấu hình | ✅ hiện đúng, và tự tắt khi sửa xong |
| 2 | Trang cấu hình hiện hai cột; KHO_HN hiện *600 / 180 · kẹp ở trần* | ✅ qua cả route (lớp 8) lẫn giao diện (lớp 9) |

### Yêu cầu gốc của chủ dự án

| Yêu cầu | Đợt 1–2 đáp ứng tới đâu | Còn lại ở |
|---|---|---|
| *"thông báo chính xác về lỗi đó là lỗi gì"* | ✅ **Phát hiện** lỗi cấu hình chính xác: tổ chức nào, kho nào, thông số nào, đặt bao nhiêu, dùng bao nhiêu, vì sao, cần làm gì. ❌ **Chưa gửi được** — xem việc mở 2 | Đợt 3, 5, 7 cho lỗi thiết bị / lúc chạy |
| *"platform phải kiểm soát được toàn bộ các kho"* | ✅ Xem cấu hình thực dùng của **mọi** tổ chức ngay trên platform, không phải đóng giả | Đợt 7 cho đội agent |
| *"quản lý dễ hơn"* | ✅ Hai cột *Đặt / Thực dùng*, dòng lệch tô màu kèm lý do | Đợt 4 cho sửa thẳng trên platform |
| *"không được fix cứng"* | ✅ Mặc định đồng bộ về một nguồn; có test khoá hằng số với định nghĩa mới nhất trong database | Đợt 6 cho mẫu cấu hình sửa được |
| Khách không đọc trộm được | ✅ 403, không lộ dữ liệu | — |

---

## Việc còn mở — phía vận hành, không phải mã

### ~~1. Bài test agent đỏ vì đụng cổng~~ — ĐÃ XONG

Chủ dự án chạy trong cmd quyền quản trị: `net stop BetacomAgent` → `npm test` → **228/228** → `net start BetacomAgent`. Lưu ý cho lần sau: `Stop-Service` là lệnh PowerShell, cmd không hiểu — trong cmd dùng `net stop` / `net start`.

**Bài test này sẽ đỏ trên MỌI máy lập trình có cài agent**, vì dịch vụ luôn giữ cổng 8554. CI không dính (chạy Ubuntu, bài chỉ chạy trên Windows). Có thể sửa bài cho dời cổng sang cổng trống như phép thử tôi đã chạy — chưa làm, vì đụng vào bài test để cho nó xanh thì phải có chủ dự án đồng ý.

### 2. Con tự kiểm nền vẫn chết — cảnh báo cấu hình không được gửi đi

`system-check` chạy lần cuối **13/08/2026 — 44 ngày trước**. Mục kiểm Cấu hình của đợt 1 phát hiện đúng và hiện đúng trên trang `/platform/system` **khi có người mở trang**, nhưng **không có tin Lark nào được gửi** cho tới khi cài timer.

Đây là **Phần 1 của kế hoạch** — việc của chủ dự án, không cần viết mã, đã có đủ lệnh trong tài liệu. Không làm việc này thì yêu cầu *"thông báo"* mới đạt nửa.
