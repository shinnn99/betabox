-- Lát 3c: người dùng xem clip đơn từ web ngoài LAN kho.
--
-- Kiến trúc:
--   Ổ agent (clip đã cắt) --upload--> Bucket Supabase Storage tạm 72h --signed URL--> Browser người xem
--
-- Bốn phần trong migration này:
--   1. Cột theo dõi upload state trong order_proof_clips.
--   2. Type mới `upload_clip` cho agent_commands (nối cut → upload).
--   3. Bucket `proof-clips-transient` private, mp4-only, 100MB.
--   4. RLS storage.objects: chỉ service_role thao tác — authenticated user
--      KHÔNG đọc trực tiếp, xem qua signed URL do backend cấp.
--
-- KHÔNG có ở migration này:
--   - CORS config: mặc định Supabase Storage `Access-Control-Allow-Origin: *`
--     đủ cho test. Cắm cọc BLOCKS-GO-LIVE mức bình thường siết origin
--     trước go-live.
--   - pg_cron TTL cleanup: `storage.delete_object` không có, trigger
--     `protect_objects_delete` chặn DELETE trực tiếp. Cleanup làm qua
--     endpoint backend `/api/admin/cleanup-expired-clips` dùng
--     supabase-js `remove([paths])`. TRƯỚC GO-LIVE bắt buộc nối
--     scheduler (Vercel Cron) — xem cọc BLOCKS-GO-LIVE dưới.

-- ---------------------------------------------------------------
-- 1) Cột upload state
-- ---------------------------------------------------------------
alter table public.order_proof_clips
  add column bucket_path text,
  add column bucket_uploaded_at timestamptz;

comment on column public.order_proof_clips.bucket_path is
  '3c: đường dẫn file trong bucket proof-clips-transient. Null khi chưa upload / đã expire.';
comment on column public.order_proof_clips.bucket_uploaded_at is
  '3c: thời điểm upload thành công. TTL đọc theo cột này so với BUCKET_TTL_HOURS (env). Cleanup manual endpoint set null khi xóa file.';

-- ---------------------------------------------------------------
-- 2) agent_commands.type: thêm 'upload_clip'
-- ---------------------------------------------------------------
alter table public.agent_commands
  drop constraint agent_commands_type_check;

alter table public.agent_commands
  add constraint agent_commands_type_check
  check (type in ('ping', 'start_recording', 'stop_recording', 'cut_clip', 'upload_clip'));

-- ---------------------------------------------------------------
-- 3) Bucket
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'proof-clips-transient',
  'proof-clips-transient',
  false,                       -- private: signed URL only, không public read
  104857600,                   -- 100 MB — dư cho clip 60s H.264 (thường 3-10MB)
  ARRAY['video/mp4']::text[]   -- mp4-only. Nếu mime khác lọt (không nên vì 3b-1 đã H.264/mp4),
                               -- bucket từ chối upload → agent báo lỗi rõ 'mime_rejected'.
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 4) RLS: chỉ service_role thao tác. Authenticated KHÔNG đọc trực
-- tiếp — buộc phải qua signed URL cấp bởi backend (sau khi backend
-- verify multi-tenant).
--
-- Backend cấp signed URL bằng service_role client → bypass RLS →
-- RLS chặn authenticated KHÔNG đá đường signed-URL. Hai đường độc
-- lập, không xung đột.
-- ---------------------------------------------------------------

-- Drop policies cũ nếu có (idempotent apply)
drop policy if exists "proof_clips_service_role_select" on storage.objects;
drop policy if exists "proof_clips_service_role_insert" on storage.objects;
drop policy if exists "proof_clips_service_role_update" on storage.objects;
drop policy if exists "proof_clips_service_role_delete" on storage.objects;

create policy "proof_clips_service_role_select"
  on storage.objects for select
  to service_role
  using (bucket_id = 'proof-clips-transient');

create policy "proof_clips_service_role_insert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'proof-clips-transient');

create policy "proof_clips_service_role_update"
  on storage.objects for update
  to service_role
  using (bucket_id = 'proof-clips-transient')
  with check (bucket_id = 'proof-clips-transient');

create policy "proof_clips_service_role_delete"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'proof-clips-transient');

-- ---------------------------------------------------------------
-- BLOCKS-GO-LIVE cọc 3c
-- ---------------------------------------------------------------
--
-- [MỨC CAO — không lướt qua ở checklist go-live]
--
-- 1. TTL CLEANUP không tự chạy. Hiện endpoint manual
--    /api/admin/cleanup-expired-clips — bấm tay khi test. Trước
--    go-live BẮT BUỘC nối Vercel Cron (hoặc Supabase Edge Function
--    scheduled) gọi endpoint đó mỗi giờ.
--
--    HẬU QUẢ NẾU QUÊN: cleanup không chạy = TTL 72h vô nghĩa =
--    cloud giữ clip VĨNH VIỄN = phản triết lý "ổ khách là chính,
--    cloud chỉ tạm" xuyên suốt cụm 3 = Betacom gánh storage phình
--    ngầm + clip bằng chứng nằm cloud lâu hơn cam kết với khách.
--    Không phải task kỹ thuật vặt — là điều kiện sống của quyết-
--    định-kiến-trúc-cốt-lõi.
--
--    Endpoint xây từ đầu nhận HAI đường vào (session admin OR
--    CRON_SECRET header) — Vercel Cron dùng đường thứ hai. Không
--    cần viết lại lúc nối.
--
-- [MỨC BÌNH THƯỜNG — phòng thủ chiều sâu]
--
-- 2. CORS bucket mặc định `Access-Control-Allow-Origin: *`. `*` ít
--    nguy vì bucket private (chỉ nới origin-được-phát, vẫn cần
--    signed URL hợp lệ). Trước go-live siết về domain production
--    qua Supabase Studio → Storage → Configuration.
--
-- 3. Multi-tenant: backend cấp signed URL bằng service_role bypass
--    RLS → PHẢI verify user's org match packing_event's org TRƯỚC
--    khi cấp URL. Không kiểm là cross-org leak.
--
-- 4. Signed URL hạn 45 phút (không 72h). Nếu bug cấp URL với hạn =
--    BUCKET_TTL_HOURS (72h), URL sống 3 ngày = rò rỉ nguy. Verify
--    test.
