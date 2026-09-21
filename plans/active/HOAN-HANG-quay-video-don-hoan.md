# Hàng hoàn — kế hoạch triển khai (kỹ thuật)

**Cập nhật:** 18/09/2026 · **Trạng thái:** kế hoạch, **chưa triển khai** · **Nhánh nền:** `2-camera`
**Luồng nghiệp vụ (đọc trước):** [LUONG-DON-DI-DON-HOAN.md](LUONG-DON-DI-DON-HOAN.md). Tài liệu này chỉ nói **làm thế nào**; **luồng chạy ra sao** nằm ở tài liệu kia.

---

## 1. Quyết định của chủ dự án

| # | Nội dung | Quyết định |
|---|---|---|
| 1 | Công cho kiện hoàn | **Không.** Kiện hoàn không vào số đơn đóng, không có cột riêng trong báo cáo nhân viên |
| 2 | Thời gian | Kiện hoàn **tự dừng sau 5 phút**. Bàn **tự về chế độ ĐÓNG HÀNG sau 5 phút** không thao tác. Segment video hoàn giữ **7 ngày** trên máy kho. Clip trên Supabase giữ **72 giờ** |
| 3 | Triển khai | **Chưa làm.** Chỉ lập kế hoạch và luồng; mọi luồng phải thắt |
| 4 | Phạm vi | **Chỉ luồng hoàn hàng, không có tính năng tiền bạc.** Luồng tham khảo Dohana, dựa trên hệ thống hiện tại |

---

## 2. Hiện trạng liên quan (đã đối chiếu code)

| Điểm | Hiện trạng | Vị trí |
|---|---|---|
| Quét lại mã | Chỉ báo trùng nếu cùng tổ chức, cùng mã, **cùng ngày**. Khác ngày → tạo đơn `valid` mới → **đếm thành đơn đóng lần hai** | `process_waybill_scan`, `supabase/migrations/20260807100000_packing_timing_single_source_180.sql:192-208` |
| Nơi đếm đơn | 4 nơi, 2 quy tắc: 3 nơi đếm `valid`; Lark đếm `valid + duplicated` | `src/lib/reports/service.ts`, `src/app/api/dashboard/overview/route.ts`, `src/app/api/dashboard/production/route.ts`, RPC `lark_digest_per_staff` |
| Khái niệm hoàn | Không có. `scan_type` chỉ `staff_qr` / `waybill`; bàn không có loại; `orders.platform` luôn `unknown` | — |
| Trần clip | 180 giây cố định | `src/lib/order-proof/clip-window.ts` |
| Tự dừng đơn | `forceStopExpiredOrders`, chạy ở màn hình bàn và heartbeat agent | `src/lib/station/force-stop-expired-orders.ts` |
| Xoá segment | `cleanup-segments.ps1`, **hằng tuần** (Chủ nhật 03:00), theo `retention_days` của tổ chức, không gọi mạng | `warehouse-agent/scripts/cleanup-segments.ps1` |
| Dùng lại được | Ca + ghi hình theo ca, 2 camera theo bàn, đọc QR bằng camera, nhập tay (`manual-scan`), cắt/ghép PiP, màn hình bàn có loa | — |

---

## 3. Mô hình dữ liệu

| Đối tượng | Thay đổi |
|---|---|
| `packing_events` | + `event_kind` (`outbound` \| `return`, not null, mặc định `outbound`; toàn bộ dữ liệu cũ là `outbound`) |
| | + `return_kind` (`rts` \| `customer_return` \| `suspect`), chỉ dùng cho lượt hoàn |
| | + `outbound_event_id` (FK tự trỏ): đơn đi cùng mã, nếu có |
| | + `inspection_result` (`ok` \| `damaged` \| `missing` \| `swapped` \| `unchecked`) |
| | + `close_reason` (`result_card` \| `end_card` \| `next_scan` \| `mode_switch` \| `shift_closed` \| `timeout` \| `suspect`) |
| `packing_events.status` | Giữ các giá trị cũ; thêm `duplicated_return` |
| `timing_status` | Thêm `finalized_by_mode_switch` cho đơn đi bị đóng vì chuyển chế độ |
| View `counted_outbound_events` | `status='valid' AND event_kind='outbound'`. **Nguồn duy nhất** cho mọi nơi đếm đơn |
| `packing_stations` | + `purpose` (`outbound` \| `return`, mặc định `outbound`) |
| Bảng mới `station_mode_periods` | `station_id`, `mode`, `started_at`, `ended_at`, `started_by` (`card` \| `purpose` \| `system`), `ended_reason`. Mỗi bàn **đúng một** kỳ đang mở (unique partial index) |
| Bảng mới `return_claims` | `packing_event_id` (unique), `status` (`open` \| `submitted` \| `dismissed` \| `expired`), `deadline_at`, `platform_claim_ref` (tuỳ chọn), `note`, `updated_by`. **Không lưu số tiền** |
| `warehouse_scan_raw_events.scan_type` | + `control` (thẻ điều khiển) |
| `packing_timing_config` | + `return_max_seconds` = **300**, `return_idle_revert_seconds` = **300**, `return_claim_hours` = 168, `return_segment_retention_days` = **7**, `return_lookback_days` = 60 |
| `camera_recording_files` | + `retention_class` (`default` \| `return_short`), mặc định `default` |

**Thẻ điều khiển (in sẵn):**
- chế độ: `BETABOX:MODE:RETURN`, `BETABOX:MODE:OUTBOUND`;
- kết quả: `BETABOX:RESULT:OK`, `BETABOX:RESULT:DAMAGED`, `BETABOX:RESULT:MISSING`, `BETABOX:RESULT:SWAPPED`;
- kết thúc: `BETABOX:END`.

---

## 4. Hạn lưu 7 ngày cho segment hoàn

Dùng **chung** `cleanup-segments.ps1`, chỉ thêm một bước.

| Bước | Ai làm | Khi nào |
|---|---|---|
| 1. Segment lên cloud với `retention_class=default` | agent (như nay) | mỗi phút |
| 2. Phân loại `return_short` | cloud | khi kỳ NHẬN HOÀN của bàn đóng, và chạy bù mỗi ngày |
| 3. Agent tải danh sách file `return_short` về `retention-plan.json` | agent qua heartbeat | khi có bản mới |
| 4. Xoá | `cleanup-segments.ps1`, lịch đổi sang **hằng ngày 03:00** | hằng ngày |

**Điều kiện để một segment thành `return_short` (phải đủ cả ba):**
1. toàn bộ thời gian của segment nằm trong kỳ NHẬN HOÀN của bàn mà camera đang gắn lúc đó (`station_mode_periods` + `station_device_assignments`);
2. không giao với cửa sổ clip của **bất kỳ** đơn đi nào, kể cả đơn trùng và đơn chưa đóng;
3. camera không phục vụ bàn nào khác trong khoảng đó.

Thiếu dữ liệu hoặc cache hỏng → giữ `default` (theo `retention_days`, hiện 35 ngày). **Thà giữ lâu còn hơn xoá sớm bằng chứng đơn đi.**

**Script xoá chạy theo thứ tự:**
1. Như cũ: xoá file cũ hơn `retention_days`.
2. Mới: xoá file có trong `retention-plan.json` và cũ hơn 7 ngày.

Thiếu hoặc hỏng `retention-plan.json` → chỉ chạy bước 1, ghi cảnh báo.

Phải đổi lịch sang hằng ngày. Nếu vẫn chạy mỗi Chủ nhật, segment hoàn sẽ sống 7–14 ngày thay vì 7.

---

## 5. Bất biến bắt buộc (mỗi cái có test tự động)

1. Mọi nơi đếm đơn (báo cáo, tổng quan, sản lượng, Lark) **chỉ** đọc `counted_outbound_events`. Tạo một kiện hoàn → không nơi nào tăng số.
2. Một kiện hoàn không bao giờ đóng hay đổi thời lượng của một đơn đi. Ngoại lệ duy nhất là chuyển chế độ, và việc đó ghi rõ `finalized_by_mode_switch`.
3. Mỗi bàn có đúng một kỳ chế độ đang mở, và tối đa một lượt đang mở tại mỗi thời điểm.
4. Mọi kiện hoàn kết thúc trong **5 phút**, kể cả khi agent, màn hình bàn và nhân viên đều im lặng.
5. Mọi kiện hoàn không `ok` đều có hồ sơ, và mọi hồ sơ tới trạng thái cuối trước hoặc tại `deadline_at`.
6. Segment chỉ bị xoá sau 7 ngày khi đủ ba điều kiện ở mục 4; mọi trường hợp nghi ngờ giữ theo `retention_days`.

---

## 6. Các đợt triển khai

Quy trình mỗi đợt: viết migration riêng → chạy thử trên bản sao local trong transaction rồi ROLLBACK → chủ dự án áp lên production → kiểm thật.

### Đợt 1 — Tách kiện hoàn khỏi số đơn đóng
- **Migration:** `event_kind`, `return_kind`, `outbound_event_id`, `inspection_result`, `close_reason`, `duplicated_return`, `finalized_by_mode_switch`, view `counted_outbound_events`; sửa `lark_digest_per_staff` đọc view.
- **Code:** 3 nơi đếm còn lại chuyển sang view.
- **RPC `process_waybill_scan`:** thêm lưới an toàn (mã đã đóng ngày khác trong 60 ngày → kiện hoàn `suspect`).
- **Test:** bất biến 1, 2.
- **Xong khi:** quét lại một mã đã đóng hôm trước → không được đếm, không cắt video đơn đang mở, loa nhắc đúng câu.

### Đợt 2 — Chế độ bàn và thẻ điều khiển
- **Migration:** `packing_stations.purpose`, `station_mode_periods`, `scan_type=control`.
- **Route quét:** `api/warehouse/scans` nhận diện thẻ `BETABOX:*` trước mọi xử lý khác; `manual-scan` nhận thêm chế độ.
- **Tự về chế độ ĐÓNG HÀNG:** cùng nhịp với `forceStopExpiredOrders` và trigger đóng ca.
- **Giao diện:** chọn chế độ mặc định của bàn ở Thiết bị kho; trang in thẻ QR; nhãn chế độ trên màn hình bàn.
- **Test:** bất biến 3; mọi dòng của bảng chế độ bàn trong tài liệu luồng.
- **Xong khi:** chuyển chế độ bằng thẻ, tự về sau 5 phút rảnh và khi đóng ca đều đúng.

### Đợt 3 — Vòng đời kiện hoàn, hồ sơ, video
- **RPC:** nhánh NHẬN HOÀN; thẻ kết quả; 8 cách kết thúc; `return_claims`.
- **Tự dừng:** `forceStopExpiredOrders` thêm nhánh `event_kind=return` với trần 300 giây.
- **Clip:** `clip-window.ts` lấy trần theo `event_kind`; cắt ngay khi kết quả khác `ok`; trạng thái "quá 7 ngày" ở route watch / retry.
- **Giao diện:** trang Hàng hoàn (video đi và hoàn cạnh nhau, nút Đã khiếu nại / Không cần); màn hình bàn đếm ngược 5 phút, ô Nhập tay; báo Lark.
- **Test:** bất biến 4, 5.
- **Xong khi:** mọi đường trong tài liệu luồng mục 5 tới đúng trạng thái cuối.

### Đợt 4 — Hạn lưu 7 ngày
- **Migration:** `camera_recording_files.retention_class`.
- **Cloud:** job phân loại (mục 4) và endpoint trả danh sách cho agent.
- **Agent:** cache `retention-plan.json`; thêm bước 2 vào `cleanup-segments.ps1`; lịch hằng ngày. Cần bộ cài agent mới.
- **Test:** bất biến 6; cache hỏng → chỉ xoá theo `retention_days`.
- **Xong khi:** segment thuần hoàn bị xoá ở ngày thứ 8; segment dính đơn đi còn đủ `retention_days`.

### Kịch bản kiểm thử đầu-cuối (sau đợt 4)
1. **Bàn chuyên hoàn:** kiện giao thất bại → nối đơn đi → thẻ OK → không hồ sơ.
2. **Bàn đóng hàng:** thẻ HOÀN → kiện khách trả, nhập tay → thẻ TRÁO → clip cắt ngay → hồ sơ Cần xử lý → Đã khiếu nại.
3. **Quên thẻ kết quả:** quét kiện kế tiếp → kiện trước "chưa kiểm" → có hồ sơ.
4. **Để kiện mở:** sau 5 phút → tự dừng, "chưa kiểm", có hồ sơ.
5. **Quên chuyển về:** rảnh 5 phút → tự về ĐÓNG HÀNG; đơn đi sau đó được đếm bình thường.
6. **Lưới an toàn:** quét mã đã đóng hôm trước ở ĐÓNG HÀNG → không được đếm, đơn đang mở không bị cắt.
7. **Hết hạn:** hồ sơ để quá 7 ngày → Hết hạn; giả lập ngày thứ 8 → segment hoàn bị xoá, mở clip báo "quá 7 ngày".

---

## 7. Rủi ro

| Rủi ro | Mức | Chặn |
|---|---|---|
| Sót một nơi đếm đơn → kiện hoàn bị đếm thành đơn đóng | Cao | View duy nhất + test bất biến 1 cho từng nơi |
| Xoá nhầm segment của đơn đi sau 7 ngày | Cao | Ba điều kiện, mặc định giữ theo `retention_days`, test riêng |
| Kiện nhiều sản phẩm cần hơn 5 phút để kiểm | Trung bình | Tự dừng "chưa kiểm" vẫn có hồ sơ và video; nhân viên quét lại mã kiện để mở lượt mới (ghi trùng hoàn, video phần sau vẫn nằm trong segment). Nếu hay gặp, chủ kho nâng `return_max_seconds` |
| Tranh chấp kéo dài quá 7 ngày, mất bản gốc | Trung bình | Clip đã cắt tải về được; hồ sơ nhắc tải khi mở |
| Quên chuyển chế độ | Trung bình | Tự về sau 5 phút rảnh và khi đóng ca; nhãn chế độ nền cam |
| Kiện khách trả không có QR | Trung bình | Ô Nhập tay |
| Kiện hoàn dồn dập, nhiều lệnh cắt ngay | Thấp | Hàng đợi cắt clip hiện có, mỗi lượt hỏi lệnh nhận tối đa một lệnh cắt |

---

## 8. Ngoài phạm vi

- Mọi tính năng tiền bạc: số tiền khiếu nại, tiền thu hồi, đơn giá.
- Nối API Shopee / TikTok Shop để tự nối mã khách trả với đơn gốc.
- Đọc mã viết tay bằng ảnh.
- Nhận diện sàn từ mã vận đơn.
- Chế độ bàn giao shipper, đơn huỷ ngang, quay trước khi có mã (các tính năng Dohana có).
