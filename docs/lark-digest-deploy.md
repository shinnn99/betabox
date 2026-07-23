# Deploy Lark Digest — hướng dẫn từng bước

Sau khi merge code, cần **3 bước** để digest chạy: apply migration, deploy Edge Function, schedule pg_cron.

## Bước 1 — Apply 2 migrations (SQL Editor Supabase)

**Migration A** — `20260713200000_lark_digest_config.sql`: 3 cột `notify_lark_digest_*` + event_type CHECK.

**Migration B** — `20260713220000_lark_digest_rpc.sql`: RPC `lark_digest_per_staff`.

Paste nội dung 2 file vào SQL Editor, Run từng cái. Kỳ vọng: không error, postcondition PASS.

Verify:

```sql
-- Cột digest
SELECT column_name, column_default FROM information_schema.columns
WHERE table_name='warehouses' AND column_name LIKE 'notify_lark_digest_%';

-- RPC exists
SELECT proname FROM pg_proc WHERE proname='lark_digest_per_staff';

-- Test RPC (0 row nếu chưa có packing_events trong window)
SELECT * FROM public.lark_digest_per_staff(
  'bfc8f284-841b-4f5e-a706-8d761fd0b05d'::uuid,
  now() - interval '24 hours',
  now()
);
```

## Bước 2 — Deploy Supabase Edge Function

Yêu cầu: Supabase CLI đã cài (`npx supabase --version`).

```bash
# Từ thư mục d:\Betacom\beta_cam
cd d:\Betacom\beta_cam

# Login (chỉ 1 lần)
npx supabase login

# Link project (chỉ 1 lần)
npx supabase link --project-ref <PROJECT_REF>
# PROJECT_REF: tìm ở Supabase Dashboard → Settings → General → Reference ID

# Set secret DIGEST_SECRET (chuỗi random dài, VD: openssl rand -hex 32)
# Đây là secret pg_cron dùng để gọi Edge Function.
npx supabase secrets set DIGEST_SECRET=<CHUỖI_RANDOM_DÀI>

# Deploy function
npx supabase functions deploy lark-digest --no-verify-jwt
```

**Lưu ý `--no-verify-jwt`**: Edge Function tự verify bằng `DIGEST_SECRET`, không dùng Supabase JWT auth (pg_cron không có JWT).

Verify:

```bash
# Gọi thử với secret (không có body → invalid_period)
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest" \
  -H "Authorization: Bearer <DIGEST_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"period":"daily"}'

# Kỳ vọng: {"ok":true,"period":"daily",...}
# Nếu chưa kho nào bật digest: "warehouses_processed":0
```

## Bước 3 — Schedule pg_cron (SQL Editor)

Cần lưu `DIGEST_SECRET` vào Postgres setting để pg_cron dùng. **Chỉ chạy 1 lần**:

```sql
-- Set secret trong DB (chỉ superuser). Nếu không có quyền, hardcode secret
-- trực tiếp trong cron.schedule bên dưới (kém an toàn hơn).
ALTER DATABASE postgres SET app.digest_secret = '<DIGEST_SECRET>';
```

Sau đó schedule 3 cron:

```sql
-- Daily 22:00 VN = 15:00 UTC
SELECT cron.schedule(
  'lark-digest-daily',
  '0 15 * * *',
  $$
  SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.digest_secret')
    ),
    body := jsonb_build_object('period', 'daily')
  );
  $$
);

-- Weekly thứ 2 08:00 VN = thứ 2 01:00 UTC
SELECT cron.schedule(
  'lark-digest-weekly',
  '0 1 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.digest_secret')
    ),
    body := jsonb_build_object('period', 'weekly')
  );
  $$
);

-- Monthly ngày 1 08:00 VN = ngày 1 01:00 UTC
SELECT cron.schedule(
  'lark-digest-monthly',
  '0 1 1 * *',
  $$
  SELECT net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.digest_secret')
    ),
    body := jsonb_build_object('period', 'monthly')
  );
  $$
);
```

Verify schedule:

```sql
SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'lark-digest-%';
```

Kỳ vọng: 3 row.

## Bước 4 — Bật digest cho 1 kho + test

1. Mở `/dashboard/settings/warehouse-config` → chọn kho → bấm ✏️.
2. Trong panel: tick **Báo cáo cuối ngày** → Lưu thay đổi.
3. Đợi tới 22:00 VN hôm đó, hoặc test ngay:

```bash
# Trigger digest daily thủ công
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/lark-digest" \
  -H "Authorization: Bearer <DIGEST_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"period":"daily"}'
```

Kỳ vọng: tin digest xuất hiện trong nhóm Lark của kho, với header xanh "**[Tên kho] Báo cáo ngày**" + tổng số đơn + top nhân sự.

## Debug nếu tin không tới

```sql
-- Xem log digest gần nhất
SELECT event_type, status, response_status, error_message,
       left(response_body, 200) AS body, sent_at
FROM public.notification_logs
WHERE event_type LIKE 'digest_%'
ORDER BY sent_at DESC LIMIT 10;
```

- `status='failed'` + `error_message='lark_code_9499...'` → webhook token sai.
- Không có row → Edge Function không gọi được / kho chưa bật digest / kho chưa có webhook.

## Ghi chú

- **Config bật/tắt per kho**: mặc định 3 field digest = `false`. Chỉ gửi khi user bật trong UI.
- **notify_lark_enabled cũng phải bật**: digest kiểm cả `notify_lark_enabled AND digest_X AND webhook != NULL`.
- **Format hiện tại đơn giản**: tổng theo kho + list nhân sự (max 15). Sẽ tinh chỉnh sau khi Betacom dùng thật vài tuần.
