# PLATFORM — Quản lý cấu hình tập trung, thôi phải đóng giả vào từng tổ chức

**Trạng thái:** Kế hoạch, chưa viết dòng mã nào
**Ngày:** 25/09/2026
**Chủ dự án yêu cầu:** "đọc trang platform và tìm giải pháp để quản lý dễ hơn"
**Liên quan:** `src/lib/system/checks.ts` (bộ giám sát đang chạy), `plans/reports/codebase.md`

---

## 0. Bốn quyết định của chủ dự án (25/09/2026)

Kế hoạch này viết theo bốn câu trả lời dưới đây. Ghi lại nguyên văn vì chúng đổi hình dạng của mục 2 và mục 3 khá nhiều.

| # | Câu hỏi | Trả lời | Hệ quả |
|---|---|---|---|
| 1 | Platform có được **sửa** cấu hình không, hay chỉ xem? | **Có** | Cần route platform riêng, ghi audit với danh tính admin nền tảng |
| 2 | Bộ giá trị chuẩn cho tổ chức mới là gì? | **"tôi muốn tự điều chỉnh theo nhu cầu được, không được fix cứng"** | **Không** dùng `DEFAULT` ở database, **không** hằng số trong mã. Phải có chỗ lưu mẫu sửa được trên giao diện |
| 3 | Mấy trần kỹ thuật đang hardcode — chỉ hiện ra, hay cho đặt? | **Cho đặt** | Trần clip, độ dài đoạn ghi, sàn ổ đĩa đều thành cấu hình. Cần lan can, xem mục 3.5 |
| 4 | Mục E có đáng nâng cấp agent một bản riêng? | **Gộp bản sau** | Phần agent của mục 3 và mục E **gộp chung một bản phát hành** |

Câu 3 và câu 4 ăn khớp nhau một cách may mắn: `segment_seconds` và sàn ổ đĩa đều nằm ở agent, mà mục E cũng là việc agent. **Một bản agent chở cả hai** — xem đợt 6.

---

## 1. Kết luận trước, lý lẽ sau

Trang platform **quản lý được tổ chức, nhưng không quản lý được cấu hình**. Tab Cấu hình chỉ hiện hai ô rồi ghi thẳng: *"Cấu hình chi tiết mỗi kho nằm trong dashboard tổ chức — bấm Bắt đầu hỗ trợ để vào xem"*.

Tệ hơn: **cấu hình là điểm mù duy nhất của bộ giám sát**. Mười phép kiểm tra hiện có đều về vận hành — agent, camera, ghi hình, cron, ổ đĩa. Không phép nào hỏi "kho này đã cấu hình đủ chưa, và giá trị đặt có thật sự được dùng không".

Ba thứ đo được trên database thật hôm nay, quyết định hình dạng kế hoạch:

| Đo cái gì | Kết quả | Hệ quả |
|---|---|---|
| Hạn lưu video hoàn hàng của hai tổ chức | **Cả hai đều NULL** | Con số 7 ngày đang chạy là **mặc định trong mã nguồn**, không ai đặt. Giao diện chỉ hiện "Chưa đặt" |
| `max_order_seconds` của kho Betacom Demo | Đặt **600**, tầng video và tự-dừng-đơn kéo về **180** | Giá trị đặt xong **bị kẹp âm thầm**. Chỉ có `console.warn` ở máy chủ, không ai đọc |
| Lệnh tạo tổ chức ghi những cột nào | Chỉ `{name, slug}`; database **không có giá trị mặc định** cho hai cột hạn lưu | Mỗi tổ chức mới ra đời ở trạng thái chưa cấu hình |

Và **một nhận xét quyết định cách làm**: bộ khung giám sát ở trang Tình trạng hệ thống đã tốt sẵn — ngưỡng gom một chỗ trong `CHECK_CONFIG`, mỗi cảnh báo tách riêng *Triệu chứng* và *Cần làm*, có sẵn khái niệm "điểm mù". **Kế hoạch này bám vào khung đó, không dựng khung mới.**

---

## 2. Hiện trạng (đọc từ mã nguồn và database thật)

### 2.1. Trang platform có gì

| Trang | File | Làm được gì |
|---|---|---|
| Tổ chức | `src/app/platform/page.tsx` | Danh sách, tìm, lọc theo trạng thái, tạo tổ chức mới |
| Tổ chức → chi tiết | `src/app/platform/orgs/[id]/page.tsx` | 4 tab: Tổng quan / Thành viên / Nhật ký / Cấu hình |
| Tình trạng hệ thống | `src/app/platform/system/page.tsx` | 10 phép kiểm tra, mục "Cần chú ý", bảng kho đang vận hành, khối hạ tầng |
| Quản trị viên | `src/app/platform/admins/page.tsx` | Quản lý admin nền tảng |
| Nhật ký | `src/app/platform/audit/page.tsx` | Audit toàn hệ thống |

Ngoài ra có **đóng giả** ("Bắt đầu hỗ trợ") — `src/app/api/platform/impersonate/route.ts`.

### 2.2. Cấu hình nằm ở đâu, ai đọc

Phần này **làm đúng**: có đường dây thật từ giao diện xuống tới chỗ dùng, không hardcode.

| Thông số | Đặt ở | Ai thực sự đọc |
|---|---|---|
| `retention_days` | Tổ chức | heartbeat → agent ghi `retention-cache.json` → `cleanup-segments.ps1` đọc; `clip-resolver` dùng để báo quá hạn |
| `return_retention_days` | Tổ chức | `/api/agent/retention-plan` |
| `max_order_seconds` | Kho | `process_waybill_scan` (SQL), `resolveOrderLimitSeconds` |
| `video_pre_seconds`, `video_before_next_seconds`, `video_default_post_seconds` | Kho | `clip-resolver.ts` |
| `session_fallback_seconds` | Kho | `process_waybill_scan` (SQL) |
| `return_max_seconds` | Kho | `resolveReturnLimitSeconds` |

Phía database làm sạch: `resolve_packing_timing(warehouse_id)` = **mặc định phủ bởi giá trị kho đã lưu**. Kho thiếu key nào tự nhận mặc định key đó, không hàm nào tự `coalesce` một con số riêng. **Kế hoạch này dùng lại đúng cơ chế đó cho mọi thông số mới** — không dựng chỗ lưu thứ hai.

**Giá trị thật đang chạy (đọc 25/09/2026):**

| | Betacom kho KĐT Đại Kim | Betacom (demo) |
|---|---|---|
| `retention_days` | 30 | 35 |
| `return_retention_days` | **NULL** | **NULL** |
| `max_order_seconds` | 180 | **600** (bị kẹp về 180) |
| `video_pre_seconds` | 5 | 10 |
| `session_fallback_seconds` | 30 | 30 |
| `return_max_seconds` | **không có key** | **không có key** |

### 2.3. Thứ đang hardcode — chủ dự án chốt **cho đặt**

| Hằng số | Giá trị | Ở đâu | Ai đọc |
|---|---|---|---|
| `MAX_CLIP_DURATION_SECONDS` | 180s | `clip-window.ts` | cắt clip đơn đi, ước lượng dung lượng |
| `MAX_RETURN_CLIP_DURATION_SECONDS` | 310s | `clip-window.ts` | cắt clip kiện hoàn |
| `MIN_CLIP_DURATION_SECONDS` | 15s | `clip-window.ts` | sàn độ dài clip |
| `WORK_ENDED_POST_BUFFER_SECONDS` | 5s | `clip-window.ts` | đệm sau khi đóng đơn |
| `ORDER_HARD_LIMIT_SECONDS` | 180s | `order-timeout.ts` | trần kẹp `max_order_seconds` |
| `segment_seconds` | 60s | `src/lib/camera/active-credentials.ts` | agent ghi hình, bộ giữ ổ đĩa |
| sàn bộ giữ ổ đĩa | 7 ngày | `warehouse-agent/src/disk-guard.ts` | phanh cuối chống xoá sạch |

Riêng **agent đọc `.env` trên máy kho**, không lấy từ cloud: `QR_FRAME_*`, `DISK_GUARD_*`, `RECORDING_DIR`, `BACKEND_URL`… Chỉ đúng `retention_days` đi từ cloud xuống. Heartbeat hiện chỉ gửi `ping`, độ lệch giờ, nhịp watchdog — **không gửi phiên bản, không gửi ngưỡng nào**.

---

## 3. Thiết kế

### 3.1. Ba tầng giá trị, một phép giải

Sau kế hoạch này mỗi thông số đi qua đúng ba tầng:

```
mẫu nền tảng  →  giá trị tổ chức / kho  →  lan can kỹ thuật
(chỉ dùng          (người vận hành          (khoảng cho phép,
 lúc TẠO)           đặt, sửa bất kỳ lúc nào) cũng đặt được)
```

Một hàm duy nhất giải ra **giá trị thực dùng** + **lý do** nếu khác giá trị đặt. Mọi nơi hiện cấu hình, mọi phép kiểm tra, mọi API đều gọi hàm này. Đây là xương sống của cả kế hoạch — làm sai chỗ này thì bảng giám sát nói một đằng hệ thống chạy một nẻo.

### 3.2. Mẫu nền tảng — **copy lúc tạo**, không phải tầng phủ lúc đọc

Chủ dự án chốt: không fix cứng, phải tự điều chỉnh được. Nên mẫu **lưu trong database và sửa trên trang platform**, không phải `DEFAULT` của cột, không phải hằng số trong mã.

Còn một lựa chọn nữa phải chốt rõ, vì nó quyết định hành vi:

| Cách | Ý nghĩa | Rủi ro |
|---|---|---|
| **Copy lúc tạo** ✅ đề xuất | Tạo tổ chức thì chép mẫu vào tổ chức đó. Sau đó mẫu và tổ chức độc lập | Sửa mẫu không ảnh hưởng tổ chức cũ — muốn đổi hàng loạt phải sửa từng cái |
| Tầng phủ lúc đọc | Tổ chức không đặt thì rơi về mẫu | **Sửa mẫu âm thầm đổi mọi tổ chức chưa đặt.** Một lần sửa mẫu có thể đổi hạn lưu video của kho đang chạy mà không ai bấm gì |

**Chọn copy lúc tạo.** Tiện lợi của cách hai không đáng với rủi ro đổi nhầm cấu hình của kho đang vận hành. Nếu sau này cần đổi hàng loạt thì làm một nút "áp mẫu cho các tổ chức đang chọn" — hành động **có người bấm**, có audit, khác hẳn với đổi âm thầm.

### 3.3. Trần kỹ thuật thành cấu hình — đặt ở tầng nào

Không đẻ bảng mới. Tận dụng chỗ đã có:

| Thông số | Tầng | Chỗ lưu | Ai nhận |
|---|---|---|---|
| Trần clip đơn đi / kiện hoàn, sàn clip, đệm cuối đơn | **Kho** | `packing_timing_config` | cloud đọc qua `resolve_packing_timing` |
| Trần kẹp `max_order_seconds` | **Kho** | `packing_timing_config` | `resolveOrderLimitSeconds` |
| Độ dài đoạn ghi (`segment_seconds`) | **Kho** | `packing_timing_config` | agent, qua `active-credentials` |
| Sàn bộ giữ ổ đĩa | **Tổ chức** | cột mới cạnh `retention_days` | agent, qua heartbeat — **y hệt đường `retention_days` đang chạy** |

Hai đường xuống agent đều đã tồn tại và đã chạy thật, không phải phát minh gì mới.

### 3.4. Sửa trên platform — chốt về trách nhiệm

Hai API `PATCH` sẵn có (`/api/organization`, `/api/warehouses/[id]`) lấy `organization_id` **từ phiên đăng nhập của người dùng tenant**. Gọi thẳng từ platform là không được.

Làm một route platform riêng, và **bắt buộc**:
- lấy `organization_id` từ tham số đường dẫn, không từ phiên;
- dùng lại đúng hàm validate của API tenant — không chép luật sang chỗ thứ hai;
- **ghi audit với danh tính admin nền tảng**, không ghi thành "chủ tổ chức tự sửa". Sai chỗ này là mất dấu vết ai đã đổi cấu hình kho.

### 3.5. Lan can cho quyết định "cho đặt"

Tôi đã nêu lo ngại rằng cho đặt là mở đường cho cấu hình hỏng; chủ dự án chốt cho đặt, nên kế hoạch làm theo. Nhưng ba chỗ dưới đây có **hậu quả thật**, phải có lan can chứ không thả nổi:

**a. Trần clip nối thẳng với đường lên.** Agent có `MAX_PROOF_CLIP_UPLOAD_BYTES`, và trang bằng chứng có cảnh báo "Proof có nguy cơ vượt giới hạn" tính theo trần 180s. Nâng trần mà không nâng hai thứ kia = clip cắt xong **không lên được**, người dùng thấy đơn có clip mà bấm vào không xem được. → Khi đổi trần, ô nhập phải hiện ngay dung lượng ước tính và cảnh báo nếu vượt.

**b. Sàn bộ giữ ổ đĩa là phanh cuối.** Nó tồn tại để "tệ nhất là xoá xuống sàn, không xoá sạch". Đặt xuống 1 ngày là tháo phanh. → Vẫn cho đặt, nhưng thêm một phép kiểm tra: **sàn thấp hơn hạn lưu của tổ chức là mâu thuẫn**, hiện đỏ ở "Cần chú ý".

**c. Độ dài đoạn ghi đổi thì bộ giữ ổ đĩa tính sai cho tới khi ghi lại.** `disk-guard` ước lượng tốc độ đầy ổ theo `số_file × segmentSeconds`. Đổi từ 60s sang 30s thì các file **cũ** vẫn là 60s. → Agent phải nhận giá trị mới và **khởi động lại ghi hình** mới có tác dụng; tài liệu phải nói rõ là không tức thì.

**Nguyên tắc chung cho cả ba:** mỗi thông số có một khoảng cho phép, **khoảng đó cũng đặt được** (đúng ý "không fix cứng"), nhưng khoảng ngoài cùng thì ghi thẳng trong mã và không đổi được — đó là giới hạn vật lý (dung lượng tải lên, sàn không-âm), không phải lựa chọn nghiệp vụ.

---

## 4. Việc cụ thể theo đợt

### Đợt 1 — Phép kiểm tra "Cấu hình" (nhỏ, làm được ngay)

Thêm một `checkKey` vào `CHECK_KEYS`, viết hàm kiểm tra theo mẫu các hàm đã có. Ba luật:

| Luật | Câu sẽ hiện ở "Cần chú ý" |
|---|---|
| Thiếu giá trị bắt buộc | *Triệu chứng:* Tổ chức X chưa đặt hạn lưu video hoàn hàng, đang chạy mặc định 7 ngày. *Cần làm:* vào Cấu hình, điền ô Thời gian lưu video hoàn |
| Giá trị bị kẹp | *Triệu chứng:* Kho Y đặt thời gian tối đa mỗi đơn 600 giây nhưng video và tự dừng đơn chỉ tới 180 giây. *Cần làm:* hạ về 180, hoặc nâng trần kỹ thuật |
| Cấu hình mâu thuẫn | Sàn ổ đĩa thấp hơn hạn lưu của tổ chức; trần clip cho ra file lớn hơn giới hạn tải lên |

Không phụ thuộc đợt nào khác. **Biến điểm mù thành việc nhìn thấy được, trước khi đụng vào bất cứ cấu hình nào.**

### Đợt 2 — Phép giải "Đặt / Thực dùng"

Một hàm trả về `{ đặt, thực_dùng, lý_do_khác }` cho từng thông số, dùng chung cho cloud. Đây là xương sống (mục 3.1).

Mọi nơi hiện cấu hình đổi sang hai cột:

| Thông số | Đặt | Thực dùng | Vì sao khác |
|---|---|---|---|
| Hạn lưu video hoàn | — | 7 ngày | chưa đặt, đang dùng mặc định |
| Thời gian tối đa mỗi đơn | 600s | 180s | kẹp ở trần kỹ thuật của video |

Đợt 1 viết lại để gọi hàm này thay vì tự tính — **không để hai chỗ tự tính ra hai con số**.

### Đợt 3 — Bảng cấu hình toàn hệ thống + sửa được

Gộp hai việc vì chúng dùng chung một màn hình.

- Lưới **mọi tổ chức × kho**, mỗi cột một thông số. Ô đã đặt tay và ô đang chạy mặc định **tô khác màu**.
- Sửa ngay trên lưới, qua route platform ở mục 3.4.
- Đọc qua đúng `resolve_packing_timing` của database. Tự gộp mặc định lần nữa ở tầng JavaScript là đẻ ra nguồn sự thật thứ hai.

### Đợt 4 — Mẫu cấu hình nền tảng, sửa được

- Chỗ lưu mẫu (mục 3.2), trang sửa trên platform.
- Lệnh tạo tổ chức chép mẫu vào tổ chức mới.
- **Không** đặt `DEFAULT` cho cột ở database — đó đúng là "fix cứng" mà chủ dự án không muốn.
- Nút "áp mẫu cho tổ chức đang chọn" — hành động có người bấm, có audit.

### Đợt 5 — Mở trần kỹ thuật thành cấu hình (phần cloud)

Trần clip, sàn clip, đệm cuối đơn, trần kẹp `max_order_seconds` → vào `packing_timing_config`, kèm lan can mục 3.5a.

**Phải làm sau đợt 2**, vì mở trần mà chưa có cột "Thực dùng" thì không ai kiểm chứng được là giá trị mới có tác dụng thật hay lại bị kẹp ở chỗ khác.

### Đợt 6 — Một bản agent chở cả hai việc còn lại

Chủ dự án chốt gộp. Bản agent kế tiếp mang:

**a. Nhận cấu hình từ cloud** (phần agent của đợt 5)
- `segment_seconds` lấy từ cấu hình kho thay vì hằng số 60 ở `active-credentials.ts`.
- Sàn bộ giữ ổ đĩa lấy từ heartbeat, **đi đúng đường `retention_days` đang chạy** — ghi cache local, sống qua restart, thiếu thì fail-loud.
- Đổi độ dài đoạn ghi thì phải khởi động lại ghi hình mới có tác dụng (mục 3.5c).

**b. Báo cấu hình của mình lên** (mục E cũ)
- Heartbeat mang thêm: **số phiên bản**, `QR_FRAME_*`, `DISK_GUARD_*`, thư mục ghi, dung lượng ổ.
- Đúng cái đã phải làm thủ công ngày 25/09: để biết máy kho chạy bản 0.12.0 hay chưa, phải nhờ chủ dự án gõ lệnh trên máy kho — vì `remote-logger.ts` chỉ chuyển tiếp `console.warn`/`console.error`, còn dòng nhận diện bản mới là `console.log`.

**Thứ tự trong đợt:** làm (b) trước (a). Có (b) thì lúc triển khai (a) mới nhìn được từ xa là máy kho đã nhận cấu hình mới chưa — không thì lại đoán mò đúng như hôm nay.

---

## 5. Thứ tự và lý do

**1 → 2 → 3 → 4 → 5 → 6**

| Đợt | Vì sao ở vị trí này |
|---|---|
| 1 Phép kiểm tra | Rẻ, độc lập. Biết có gì hỏng **trước khi** thêm chỗ để hỏng |
| 2 Đặt / Thực dùng | Xương sống. Đợt 3, 4, 5 đều đứng trên nó |
| 3 Bảng + sửa | Nhìn toàn cảnh và sửa được — phần lớn giá trị của cả kế hoạch nằm ở đây |
| 4 Mẫu nền tảng | Chặn tổ chức mới ra đời chưa cấu hình. Đứng sau 3 vì dùng chung màn hình và chung phép giải |
| 5 Mở trần (cloud) | Phải có cột "Thực dùng" trước mới kiểm chứng được |
| 6 Agent | Chốt gộp một bản. Cần đợt 5 xong để biết cloud gửi xuống cái gì |

**Khác với bản đề xuất hôm nay:** mẫu cấu hình tụt từ vị trí đầu xuống đợt 4. Lý do: chủ dự án muốn mẫu **sửa được**, nên nó không còn là việc rẻ nhất nữa — cần chỗ lưu, cần trang sửa, và dùng chung màn hình với đợt 3.

---

## 6. Việc làm được ngay, không cần viết mã

**Điền `return_retention_days` cho cả hai tổ chức.** Đang chạy đúng bằng mặc định nên chưa hỏng gì, nhưng nó là thứ duy nhất trong cả tài liệu này đang thật sự để trống trên production.

---

## 7. Rủi ro đã biết

| Rủi ro | Nằm ở đâu | Cách giảm |
|---|---|---|
| Hai chỗ tự tính ra hai giá trị "thực dùng" khác nhau | Đợt 1 và 2 | Đợt 2 xong thì viết lại đợt 1 để gọi chung một hàm |
| Nâng trần clip → file vượt giới hạn tải lên | Đợt 5 | Ô nhập hiện dung lượng ước tính; phép kiểm tra mâu thuẫn ở đợt 1 |
| Hạ sàn ổ đĩa → bộ giữ ổ xoá gần hết | Đợt 6 | Phép kiểm tra "sàn thấp hơn hạn lưu"; khoảng ngoài cùng ghi cứng trong mã |
| Đổi độ dài đoạn ghi nhưng ghi hình chưa khởi động lại | Đợt 6 | Agent báo giá trị đang dùng lên heartbeat — làm (b) trước (a) |
| Sửa cấu hình từ platform nhưng audit ghi nhầm người | Đợt 3 | Route riêng, audit theo danh tính admin nền tảng |
