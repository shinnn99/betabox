# Hàng hoàn — phiên ghi theo module (kế hoạch triển khai)

**Cập nhật:** 21/09/2026 · **Trạng thái:** kế hoạch, chưa triển khai · **Nhánh nền:** `2-camera`
**Đọc trước:** [LUONG-DON-DI-DON-HOAN.md](LUONG-DON-DI-DON-HOAN.md) (nghiệp vụ) và [HOAN-HANG-quay-video-don-hoan.md](HOAN-HANG-quay-video-don-hoan.md) (4 đợt đã làm xong). Tài liệu này chỉ nói phần **thay đổi thêm** sau khi chủ dự án chốt ngày 21/09/2026.

---

## 1. Yêu cầu của chủ dự án

Nguyên văn: *luồng đóng hàng lưu segment liên tục như ban đầu; luồng hoàn hàng chỉ lưu segment từ lúc bấm vào phần hoàn hàng trên sidebar; kết thúc sự kiện thì segment bao hết chỗ kết thúc video là segment cuối; user thoát giao diện mà segment đó chưa lưu xong thì chạy ngầm tới khi xong mới kết thúc; agent phải nhận được tín hiệu khi đổi module, không có tín hiệu thì không thực hiện.*

Bốn câu trả lời đã chốt:

| Câu hỏi | Chốt |
|---|---|
| Tín hiệu đến từ đâu | Trang **Hàng hoàn** trên sidebar (`/dashboard/returns`) |
| Camera nào ghi | **Cùng camera của bàn**, vẫn ghi liên tục cho đơn đi |
| Thẻ QR `BETABOX:HOAN` | **Giữ**, coi như một nguồn tín hiệu nữa |
| Phạm vi bàn | **Chọn bàn ngay trên trang Hàng hoàn** |
| Mất nhịp (trình duyệt sập, mất mạng) | Tự đóng sau **2 phút** không nhịp |

---

## 2. Một điều phải nói rõ trước khi code

Camera của bàn **vẫn chạy ffmpeg liên tục** cho luồng đóng hàng (chủ dự án đã chọn). Vì vậy đoạn video 60 giây **vẫn được ghi ra ổ đĩa** kể cả khi không ai mở module hoàn hàng — không thể vừa ghi liên tục cho đơn đi vừa không ghi cho cùng camera đó.

Cái mà tín hiệu module bật/tắt là **quyền sở hữu**: segment nào **thuộc về phiên hoàn hàng**. Segment thuộc phiên hoàn mới:
- được dùng để cắt video cho kiện hoàn,
- được xếp hạn lưu ngắn 7 ngày (đợt 4).

Không có tín hiệu → không segment nào mang nhãn hoàn → không có gì bị rút hạn, không có gì bị coi là video hoàn. Đúng với câu *"không có thì không thực hiện"*.

Nếu sau này muốn **đúng nghĩa đen** là chỉ chạy ffmpeg khi mở module, phải dùng **camera riêng cho bàn hoàn** — lúc đó đổi câu trả lời số 2 và làm thêm một đợt nữa.

---

## 3. Mô hình: phiên ghi hoàn = kỳ chế độ NHẬN HOÀN

Không thêm bảng mới. `station_mode_periods` (đợt 2) đã là *khoảng thời gian bàn ở chế độ NHẬN HOÀN* — chính là phiên ghi. Thêm cột vào đó để tránh hai vòng đời song song lệch nhau.

| Cột thêm vào `station_mode_periods` | Ý nghĩa |
|---|---|
| `holders text[]` | Ai đang giữ phiên. `'card'` (thẻ QR) hoặc `'module:<user_id>'` (một người mở trang). Rỗng = không ai giữ. |
| `capture_state text` | `none` (kỳ ĐÓNG HÀNG) · `active` (đang thuộc phiên) · `draining` (đã thoát, chờ segment cuối) · `finished` (agent đã báo xong) · `abandoned` (agent im, xem mục 6) |
| `last_heartbeat_at` | Nhịp cuối của giao diện. Quá 2 phút → nhả `module:*`. |
| `capture_ended_at` | Mốc **kết thúc segment cuối** do agent báo. Khác `ended_at` (lúc người thoát). |
| `agent_acked_at` | Lúc agent xác nhận đã nhận tín hiệu. NULL = agent chưa biết gì. |

| Cột thêm vào `camera_recording_files` | Ý nghĩa |
|---|---|
| `return_capture_id uuid` | Phiên hoàn mà segment này thuộc về. NULL = segment thường. Do **agent** gán, không suy ra từ thời gian. |

**Bất biến:** mỗi bàn tối đa một kỳ mở (đã có từ đợt 2). `capture_state='draining'` không giữ kỳ mở — kỳ đã đóng (`ended_at` có giá trị), chỉ còn chờ agent báo nốt.

---

## 4. Vòng đời một phiên

```
        bấm "Bắt đầu nhận hoàn"            thoát trang / thẻ ĐÓNG HÀNG
  (hoặc quét thẻ BETABOX:HOAN)                  / mất nhịp 2 phút
               │                                        │
               ▼                                        ▼
   holders += nguồn               ┌──────────►  holders -= nguồn
   capture_state = active         │                     │
   lệnh xuống agent: BẬT          │            còn nguồn khác? ──yes──┘
               │                  │                     │ no
               ▼                  │                     ▼
   agent gán return_capture_id    │      capture_state = draining
   cho MỌI segment của camera bàn │      lệnh xuống agent: TẮT
               │                  │                     │
               └──────────────────┘                     ▼
                                        agent vẫn gán nốt segment ĐANG GHI
                                        (tối đa 60 giây)
                                                        │
                                                        ▼
                                        segment đóng → báo cloud kèm mốc
                                        capture_state = finished
                                        capture_ended_at = ended_at segment cuối
```

Đúng yêu cầu *"thoát giao diện mà segment chưa lưu xong thì chạy ngầm tới khi xong"*: việc chạy ngầm nằm ở **agent**, không phụ thuộc trình duyệt còn mở hay không.

---

## 5. Đường tín hiệu

| Bước | Ai gọi ai | Nội dung |
|---|---|---|
| Mở | Trình duyệt → `POST /api/returns/capture` `{station_id, action:'open'}` | Mở kỳ NHẬN HOÀN (dùng lại `set_station_mode`, nguồn `module`), thêm holder, xếp lệnh cho agent |
| Nhịp | Trình duyệt → `POST /api/returns/capture` `{action:'heartbeat'}` mỗi 30 giây | Gia hạn `last_heartbeat_at` |
| Đóng | Trình duyệt → `POST /api/returns/capture` `{action:'close'}` (kể cả `sendBeacon` lúc đóng tab) | Nhả holder |
| Lệnh | Cloud → agent, lệnh `set_return_capture` | `{capture_id, station_id, camera_ids, active}` |
| Xác nhận | Agent → cloud (kết quả lệnh) | `agent_acked_at` |
| Gán nhãn | Agent → `POST /api/agent/recording-files` | Mỗi segment kèm `return_capture_id` |
| Báo xong | Agent → `POST /api/agent/return-capture` | `{capture_id, last_segment_ended_at}` → `finished` |
| Quét dọn | Nhịp heartbeat agent (đã có sẵn) | `expire_return_captures`: nhả holder quá 2 phút không nhịp; bỏ rơi phiên agent im quá 15 phút |

Thẻ QR đi đúng đường trên, chỉ khác holder là `'card'` và không có nhịp.

---

## 6. Các ca hỏng và lối ra (thắt luồng)

| Tình huống | Xử lý | Vì sao chọn thế |
|---|---|---|
| Agent offline lúc bấm Bắt đầu | Lệnh nằm trong hàng đợi; giao diện hiện **"Agent chưa nhận — chưa ghi nhãn"**. Nếu agent lên trong lúc phiên còn mở thì nhận lệnh và gán từ đó trở đi. | Không có tín hiệu thì không thực hiện — thà thiếu nhãn còn hơn gán nhãn cho đoạn không ai ghi |
| Agent nhận BẬT rồi chết trước khi nhận TẮT | Agent đọc `return-capture.json` lúc khởi động lại; thấy `draining` mà không có segment đang ghi → báo xong ngay | Không treo phiên vì một lần restart |
| Agent im luôn sau khi TẮT | Sau 15 phút cloud đặt `abandoned`, `capture_ended_at = ended_at`. Segment đã gán vẫn giữ nhãn; segment chưa gán thì thôi | Không giữ phiên mở vô hạn, cũng không tự gán nhãn thay agent |
| Trình duyệt sập / mất mạng | Quá 2 phút không nhịp → nhả holder `module:*` | Chốt của chủ dự án |
| Hai người cùng mở trang cho một bàn | Hai holder `module:<id>`; nhả hết mới `draining` | Người này thoát không được cắt ngang việc người kia |
| Thẻ HOÀN + module cùng bật | Hai holder; thẻ ĐÓNG HÀNG nhả `'card'`, module vẫn giữ | Chủ dự án muốn giữ cả hai nguồn |
| Đóng ca khi phiên đang mở | Nhả tất cả holder, đóng kiện hoàn đang mở (đã có từ đợt 3) | Không để phiên sống qua ca |
| Camera của bàn đổi giữa phiên | Agent gán theo danh sách camera trong lệnh; đổi camera thì cloud gửi lệnh mới | Danh sách camera là của cloud, agent không tự đoán |

---

## 7. Ảnh hưởng tới phần đã làm

- **Đợt 4 (hạn lưu 7 ngày):** `classify_return_segments` đổi nguồn — chỉ xét segment **có `return_capture_id`** thay vì suy từ khoảng thời gian. Vẫn giữ nguyên hai vế an toàn: không giao cửa sổ video đơn đi nào, và camera chỉ phục vụ một bàn trong khoảng đó. Chặt hơn hẳn: không có tín hiệu thì không segment nào bị rút hạn.
- **Đợt 2 (thẻ điều khiển):** `set_station_mode` gọi qua lớp mới để thêm/bớt holder; hành vi thẻ giữ nguyên với người dùng.
- **Đợt 3 (vòng đời kiện):** không đổi. Cắt video cho kiện hoàn vẫn theo mốc quét và mốc đóng kiện.

---

## 8. Các đợt

### Đợt 5 — Phiên ghi và tín hiệu xuống agent
- Migration: cột mới cho `station_mode_periods` và `camera_recording_files`; RPC `open_return_capture` / `release_return_capture` / `touch_return_capture` / `finish_return_capture` / `expire_return_captures`; `classify_return_segments` đổi nguồn.
- Cloud: `POST /api/returns/capture`, `POST /api/agent/return-capture`, lệnh `set_return_capture`, `recording-files` nhận thêm `return_capture_id`.
- Agent: `return-capture.ts` (trạng thái + file `return-capture.json`), gán nhãn ở đường báo segment, xử lý lệnh, rút ngầm khi `draining`.
- **Xong khi:** bật/tắt bằng lệnh thì segment mang đúng nhãn; tắt giữa chừng thì segment đang ghi vẫn mang nhãn và phiên chỉ kết thúc sau khi segment đó đóng.

### Đợt 6 — Giao diện trang Hàng hoàn
- Ô chọn bàn (nhớ lựa chọn lần trước), nút Bắt đầu / Kết thúc nhận hoàn, nhãn trạng thái (`Đang ghi` · `Đang lưu nốt đoạn cuối` · `Agent chưa nhận`), nhịp 30 giây, đóng bằng `sendBeacon` khi rời trang.
- **Xong khi:** mở trang và chọn bàn thì agent bắt đầu gán nhãn trong vòng một nhịp lệnh (3 giây); rời trang thì nhãn dừng sau khi segment đang ghi đóng.

### Kịch bản kiểm thử đầu-cuối
1. Mở module → quét kiện hoàn → segment trong khoảng đó có `return_capture_id`; segment trước lúc mở thì không.
2. Thoát trang giữa lúc đang ghi segment → segment đó vẫn được gán, phiên `finished` với `capture_ended_at` = lúc segment đóng.
3. Tắt agent rồi mở module → không segment nào bị gán; giao diện báo "Agent chưa nhận".
4. Hai tab cùng mở cho một bàn → đóng một tab, phiên vẫn `active`.
5. Thẻ HOÀN bật, module bật, thẻ ĐÓNG HÀNG tắt → phiên vẫn `active` vì module còn giữ.
6. Đóng tab đột ngột (không kịp báo) → sau 2 phút phiên chuyển `draining`.
7. Phân loại hạn lưu: chỉ segment có `return_capture_id` và không dính đơn đi mới thành `return_short`.
