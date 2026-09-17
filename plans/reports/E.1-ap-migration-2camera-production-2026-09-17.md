# Áp lớp database 2-camera lên production — hướng dẫn chạy tay

**Ngày:** 17/09/2026
**Migration:** [`supabase/migrations/20260917090000_two_cameras_one_agent_many_stations.sql`](../../supabase/migrations/20260917090000_two_cameras_one_agent_many_stations.sql)
**Ai chạy:** chủ dự án, trong Supabase Studio → SQL Editor. Công cụ tự động bị tầng bảo vệ chặn ghi thẳng lên production.

## Vì sao cần

Đối chiếu `supabase_migrations.schema_migrations` ngày 17/09: hai migration của nhánh 2-camera **chưa từng được áp** lên production. Thiếu:

- trigger **bật/dừng ghi theo ca**;
- trigger chụp camera QR lúc quét + cột `packing_events.proof_qr_camera_id`;
- các cột ghép góc của `order_proof_clips`, bảng `order_proof_requests`;
- ràng buộc `progress_state` trên production chỉ cho `'encoding'`, nên mọi cập nhật tiến độ `cutting`/`composing`/`uploading` của luồng ghép hai góc đang bị từ chối.

## Vì sao KHÔNG áp hai file cũ

Đã thử thực nghiệm trên bản sao local (trong transaction, ROLLBACK):

| File cũ | Lỗi |
|---|---|
| `20260914080000` | Trigger chụp camera QR đọc `cameras.station_id` — cột không tồn tại. Chèn `packing_events` báo `column c.station_id does not exist`. **Mọi lần quét mã vận đơn sẽ hỏng.** |
| `20260914165000` | Trigger ghi theo ca đòi agent gắn đúng bàn. Một agent phục vụ nhiều bàn thì mọi bàn ngoài bàn của agent không bao giờ được ghi. |

File mới gộp cả hai, sửa hai lỗi trên, bật RLS cho bảng mới (file gốc quên), và thêm lưới an toàn: lỗi ở phần phụ chỉ ghi WARNING, không chặn quét mã hay mở ca.

## Đã chạy thử trên bản sao local

Toàn bộ trong một transaction rồi ROLLBACK:

| Kịch bản | Kết quả |
|---|---|
| Mở ca ở BAN_01 — bàn KHÔNG phải bàn của agent | `start_recording hik_3 @ BAN_01` (trigger cũ: không ra lệnh nào) |
| Mở ca ở BAN_03 | thêm `dahua_3 @ BAN_03`, không trùng lệnh |
| Đóng ca BAN_01 | `stop_recording hik_3`, hẹn dừng sau 60s; BAN_03 không bị dừng |
| Quét mã ở BAN_03 | `proof_qr_camera_id = dahua_3` |
| Quét mã ở bàn không có camera | vẫn ghi được sự kiện |
| RLS `order_proof_requests` / nới `progress_state` | đúng |

## Bước 1 — áp migration

Mở file migration ở trên, dán **toàn bộ** vào SQL Editor, bấm Run. File tự bọc `BEGIN … COMMIT`: lỗi ở đâu thì không có gì được áp.

Kết quả mong đợi: `Success. No rows returned`. Hai dòng NOTICE "trigger … does not exist, skipping" là bình thường.

## Bước 2 — ghi lịch sử migration

Để `supabase db push` sau này không chạy lại hai file cũ (file `080000` sẽ cài lại trigger hỏng):

```sql
insert into supabase_migrations.schema_migrations (version, name, created_by)
values
  ('20260914080000', 'two_cameras_logic_schema',
   'thay the boi 20260917090000 - file goc co trigger hong, khong ap nguyen van'),
  ('20260914165000', 'two_cameras_shift_recording',
   'thay the boi 20260917090000 - rang buoc mot-agent-mot-ban da go'),
  ('20260916120000', 'camera_mac_identity',
   'da ap tay qua psql ngay 16/09/2026'),
  ('20260917090000', 'two_cameras_one_agent_many_stations',
   'ap tay trong SQL Editor ngay 17/09/2026')
on conflict (version) do nothing;
```

## Bước 3 — kiểm tra

```sql
select 'trigger ghi theo ca' as muc, count(*) from pg_trigger where tgname = 'staff_work_sessions_recording_commands'
union all select 'trigger chup camera QR', count(*) from pg_trigger where tgname = 'packing_events_capture_qr_camera'
union all select 'cot proof_qr_camera_id', count(*) from information_schema.columns
  where table_name = 'packing_events' and column_name = 'proof_qr_camera_id'
union all select 'RLS order_proof_requests', relrowsecurity::int from pg_class
  where oid = 'public.order_proof_requests'::regclass;
```

Mong đợi: bốn dòng đều bằng `1`.

## Bước 4 — thử thật

Quét QR nhân viên ở BAN_03 để mở ca, rồi đóng ca. Kiểm:

- mở ca: có lệnh `start_recording` cho `hik_3` và `dahua_3`, agent chạy ffmpeg ghi segment;
- đóng ca: có lệnh `stop_recording` hẹn dừng sau 60 giây.
