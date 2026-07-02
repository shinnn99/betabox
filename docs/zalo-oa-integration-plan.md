# Kế hoạch tích hợp Zalo OA Bot — Thông báo cá nhân nhân sự đóng hàng

> Tài liệu lập kế hoạch trước khi code. Lưu lại để tiếp tục phát triển ở các phase sau.
> Ngày tạo: 2026-06-28. Phase: MVP.

## 1. Mục tiêu

Khi nhân sự quét mã vận đơn, hệ thống gửi thông báo Zalo về đúng cá nhân để họ tự kiểm soát thao tác:

- `PACKING_STARTED` — đã bắt đầu đóng đơn (mặc định OFF)
- `DUPLICATE_SCAN` — quét trùng mã
- `SESSION_TOO_LONG` — đơn xử lý quá lâu chưa kết thúc
- `VIDEO_READY` — video đã lưu xong (kèm link)
- `VIDEO_ERROR` — video lỗi/không tìm thấy

Tất cả thông báo là **side effect**: thất bại không được làm fail luồng quét đơn. Mọi lần gửi (success/fail) đều ghi `notification_logs`.

## 2. Tech stack hiện tại đã xác định

| Khía cạnh        | Hiện trạng                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Framework        | Next.js 16.2.9 (App Router) + React 19.2 + TypeScript strict + Turbopack                         |
| DB/Auth          | Supabase, RLS bật toàn bộ, JWT có custom claim `organization_id` + `user_role`                    |
| Pattern API      | Route handler `runtime = "nodejs"`, dùng `requirePermission` / `requirePermissionStrict`         |
| Service-role     | `createAdminClient()` ([src/lib/supabase/admin.ts](../src/lib/supabase/admin.ts)) bypass RLS      |
| Audit            | [src/lib/audit.ts](../src/lib/audit.ts) — pure side-effect, never throw                          |
| Boot hook        | [src/instrumentation.ts](../src/instrumentation.ts) — chạy `sweepStaleSessions()` khi server up  |
| Cron pattern     | Dual auth user-session + `x-maintenance-secret` (env `MAINTENANCE_SECRET`). Đã có `pg_cron`.      |
| Migration        | Chỉ tồn tại trên remote Supabase (40 migrations). Repo CHƯA có thư mục `supabase/migrations/`.   |
| Test framework   | KHÔNG có (không jest/vitest). Đi theo pure-function + dev script.                                |

## 3. Các điểm tích hợp đã xác định

### 3.1 Luồng quét đơn (PACKING_STARTED + DUPLICATE_SCAN)

2 entry points đều insert `packing_events` qua RPC `process_waybill_scan`:

- [src/app/api/warehouse/scans/route.ts](../src/app/api/warehouse/scans/route.ts) — agent serial scan
- [src/app/api/warehouse/manual-scan/route.ts](../src/app/api/warehouse/manual-scan/route.ts) — HID/manual qua dashboard

Cả 2 nhận `packing_result.status` ∈ `{valid, duplicated, no_active_session, unmapped_scanner, invalid_code}` + `staff_id`, `waybill_code`, `previous_event_id`. **Đây là chỗ duy nhất cần hook** cho 2 event này.

### 3.2 Luồng video (VIDEO_READY + VIDEO_ERROR)

Cắt clip xảy ra trong [src/lib/order-proof/service.ts](../src/lib/order-proof/service.ts) — function `doGenerate()`. Insert pending → `cutClip()` → update `ready` hoặc `failed`. Trigger qua [src/app/api/order-proof/scans/[packingEventId]/clip/route.ts](../src/app/api/order-proof/scans/[packingEventId]/clip/route.ts).

Hook ngay sau khi update `ready`/`failed` trong `doGenerate()`. `event.staff_id` đã có trong scope.

### 3.3 Luồng SESSION_TOO_LONG

Trigger từ cron — không chạy theo từng scan. Query `packing_events.timing_status = 'open' AND scanned_at < now() - ZALO_SESSION_TOO_LONG_MINUTES`. Tạo route `/api/cron/check-long-sessions` theo pattern `close-stale-sessions` (dual auth). KHÔNG đụng `pg_cron`, chỉ TODO.

### 3.4 Staff lookup webhook

`staff_profiles` có cột `staff_code` UNIQUE per org. Webhook nhận `DK <CODE>` không biết `organization_id` → MVP scope hiện chỉ 1 org, lookup global, **assert duplicate**.

## 4. Database — Migration SQL (chỉ tạo file, KHÔNG apply)

File: `supabase/migrations/20260628120000_zalo_staff_links_and_notification_logs.sql`

### 4.1 Bảng `staff_zalo_links`

```sql
create table public.staff_zalo_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  staff_id uuid not null references public.staff_profiles(id),
  staff_code text not null,
  staff_name text,
  zalo_user_id text not null,
  is_active boolean not null default true,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 1 nhân sự chỉ active 1 liên kết
create unique index uniq_active_zalo_per_staff
  on public.staff_zalo_links (staff_id) where is_active = true;
-- 1 zalo_user_id chỉ active cho 1 nhân sự trong cùng org
create unique index uniq_active_zalo_user_per_org
  on public.staff_zalo_links (organization_id, zalo_user_id) where is_active = true;
alter table public.staff_zalo_links enable row level security;
-- KHÔNG tạo public policy. Mọi truy cập đi qua service-role.
```

### 4.2 Bảng `notification_logs`

```sql
create table public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  channel text not null check (channel in ('zalo')),
  staff_id uuid references public.staff_profiles(id),
  waybill_code text,
  event_type text not null check (event_type in (
    'PACKING_STARTED','DUPLICATE_SCAN','SESSION_TOO_LONG','VIDEO_READY','VIDEO_ERROR','LINK_CONFIRMED','LINK_FAILED'
  )),
  recipient_zalo_user_id text,
  message text not null,
  status text not null check (status in ('success','failed','skipped_debounce','skipped_no_link','skipped_disabled')),
  provider_message_id text,
  error_message text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index idx_notif_debounce on public.notification_logs (staff_id, event_type, sent_at desc);
create index idx_notif_org_recent on public.notification_logs (organization_id, sent_at desc);
alter table public.notification_logs enable row level security;
```

### 4.3 Permissions

```sql
insert into public.role_permission_matrix (role, permission_code) values
  ('owner', 'staff.zalo.view'),
  ('admin', 'staff.zalo.view'),
  ('warehouse_manager', 'staff.zalo.view'),
  ('owner', 'staff.zalo.unlink'),
  ('admin', 'staff.zalo.unlink')
on conflict do nothing;
```

## 5. Kế hoạch file thay đổi

### 5.1 Zalo core modules — `src/lib/zalo/`

| File                        | Vai trò                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `config.ts`                 | Đọc env, type-safe. Export `isEnabled()`, `isEventEnabled(event)`, `shouldVerifySignature()`           |
| `client.ts`                 | `sendZaloOAMessage({ recipientUserId, text })` gọi `https://openapi.zalo.me/v2.0/oa/message`. TODO refresh-token. |
| `signature.ts`              | Pure verify `X-ZEvent-Signature` HMAC-SHA256 (`mac=<hex>`)                                             |
| `parse.ts`                  | Pure: `parseDKCommand(text)` → `{ ok: true, staffCode } \| { ok: false, reason }`                      |
| `messages.ts`               | Pure: `buildMessage(eventType, params)` → string (5 event + reply liên kết)                            |
| `debounce.ts`               | Pure: `shouldSendByDebounce(lastSentAt, now, windowSeconds)` → boolean                                 |
| `notification-service.ts`   | Orchestrator `notifyStaffEvent({ ... })` — lookup link, debounce, send, log. Không throw lên trên.    |
| `webhook-handler.ts`        | Pure-ish: nhận parsed event → lookup staff theo `staff_code` → upsert link → return reply text         |

### 5.2 Webhook route

- `src/app/api/webhooks/zalo/route.ts` — `POST`, verify signature theo env, parse event, gọi handler, reply qua client. Không cần auth user. Trả 200 nhanh để Zalo không retry.

### 5.3 Cron route

- `src/app/api/cron/check-long-sessions/route.ts` — dual auth (user `warehouse.update` HOẶC `x-maintenance-secret`), query `packing_events` open quá ngưỡng, gửi SESSION_TOO_LONG, audit.

### 5.4 Hook vào luồng quét đơn (NON-BLOCKING — `void` fire-and-forget)

- [src/app/api/warehouse/scans/route.ts](../src/app/api/warehouse/scans/route.ts) — sau khi nhận `packingResult`:
  - `status === 'valid'` → `notifyStaffEvent(PACKING_STARTED)`
  - `status === 'duplicated'` → `notifyStaffEvent(DUPLICATE_SCAN, { previous_event_id })`
- [src/app/api/warehouse/manual-scan/route.ts](../src/app/api/warehouse/manual-scan/route.ts) — tương tự
- [src/lib/order-proof/service.ts](../src/lib/order-proof/service.ts) `doGenerate()`:
  - Sau khi update `ready` → `notifyStaffEvent(VIDEO_READY, { videoUrl })`
  - Sau khi update `failed` → `notifyStaffEvent(VIDEO_ERROR)`

**Video URL MVP**: deep-link `${APP_BASE_URL}/dashboard/order-proof?event=<packing_event_id>` (yêu cầu login). KHÔNG signed public URL — ngoài scope MVP.

### 5.5 Admin API

- `src/app/api/staff/[id]/zalo-link/route.ts`:
  - `GET` — `staff.zalo.view` — trả trạng thái + masked zalo_user_id + linked_at
  - `DELETE` — `staff.zalo.unlink` — set `is_active = false`, `unlinked_at = now()`, audit

### 5.6 Frontend (tối thiểu)

- [src/app/dashboard/staff/page.tsx](../src/app/dashboard/staff/page.tsx) — thêm 1 cột nhỏ "Zalo":
  - Trạng thái: "Đã liên kết" / "Chưa liên kết"
  - Masked zalo_user_id (last 4 chars)
  - Nút Unlink (cần `staff.zalo.unlink`)
  - Hint: "Nhắn `DK <Mã nhân sự>` vào Zalo OA Bot để liên kết."

### 5.7 Docs

- Thêm section vào `README.md`: env vars, cách lấy access_token, cấu hình webhook URL Zalo OA, test local bằng cloudflared/ngrok.

### 5.8 Dev test script

- `scripts/test-zalo-pure.ts` — chạy `node --experimental-strip-types scripts/test-zalo-pure.ts`. Test pure functions: `parseDKCommand`, `buildMessage` × 5 event, `shouldSendByDebounce`, `verifyZaloSignature`.

## 6. Env vars

```bash
# Identity
ZALO_APP_ID=
ZALO_OA_SECRET_KEY=
ZALO_OA_ACCESS_TOKEN=

# Toggles tổng
ZALO_WEBHOOK_ENABLED=false
ZALO_NOTIFY_ENABLED=false
ZALO_VERIFY_WEBHOOK_SIGNATURE=true   # production: true; local/dev: có thể false

# Toggles từng event
ZALO_NOTIFY_PACKING_STARTED=false    # OFF mặc định (chống spam)
ZALO_NOTIFY_DUPLICATE_SCAN=true
ZALO_NOTIFY_SESSION_TOO_LONG=true
ZALO_NOTIFY_VIDEO_READY=true
ZALO_NOTIFY_VIDEO_ERROR=true

# Thresholds
ZALO_SESSION_TOO_LONG_MINUTES=30
ZALO_DEBOUNCE_SECONDS=60             # tối thiểu giữa 2 tin cùng (staff,event)

# Deep-link
APP_BASE_URL=http://localhost:3000
```

## 7. Templates thông báo

```
PACKING_STARTED:
[Đóng hàng]
Bạn vừa bắt đầu đóng đơn: <WAYBILL_CODE>
Thời gian: <TIME>
Trạng thái: Đang ghi nhận video

DUPLICATE_SCAN:
[Cảnh báo đóng hàng]
Mã <WAYBILL_CODE> đã được quét trước đó.
Lần quét trước: <PREVIOUS_TIME>
Lần quét hiện tại: <CURRENT_TIME>
Vui lòng kiểm tra tránh đóng trùng hoặc nhầm đơn hoàn.

SESSION_TOO_LONG:
[Cảnh báo đóng hàng]
Đơn <WAYBILL_CODE> đang xử lý quá <MINUTES> phút.
Vui lòng kiểm tra lại thao tác đóng hàng/video.

VIDEO_READY:
[Đóng hàng]
Video đơn <WAYBILL_CODE> đã lưu thành công.
Link xem: <VIDEO_URL>

VIDEO_ERROR:
[Lỗi video]
Không xử lý được video cho đơn <WAYBILL_CODE>.
Vui lòng kiểm tra camera hoặc báo quản lý.

LINK_CONFIRMED:
[Kho] Liên kết Zalo thành công với nhân sự <STAFF_CODE> - <STAFF_NAME>.

LINK_FAILED:
[Kho] Không tìm thấy mã nhân sự. Vui lòng kiểm tra lại cú pháp: DK <MA_NHAN_VIEN>
```

## 8. Acceptance criteria

1. Nhân sự nhắn `DK NV001` vào Zalo OA Bot → hệ thống lưu `zalo_user_id` theo nhân sự.
2. NV001 quét mã vận đơn mới → hệ thống gửi tin Zalo về đúng tài khoản Zalo đã liên kết.
3. Mã vận đơn quét trùng → nhân sự nhận cảnh báo DUPLICATE_SCAN.
4. Video xử lý xong → nhân sự nhận tin VIDEO_READY có link.
5. Zalo API lỗi → luồng quét đơn vẫn thành công, lỗi ghi vào `notification_logs`.
6. Có docs hướng dẫn env, webhook URL, test local.

## 9. Thứ tự implement đề xuất

1. Migration SQL (chỉ file, không apply)
2. Pure modules: `config`, `parse`, `messages`, `debounce`, `signature`
3. `client.ts` (Zalo API call) + `notification-service.ts`
4. `webhook-handler.ts` + route `/api/webhooks/zalo`
5. Hook vào `warehouse/scans` + `warehouse/manual-scan`
6. Hook vào `order-proof/service.ts` (video ready/error)
7. Cron route `/api/cron/check-long-sessions`
8. Admin API `/api/staff/[id]/zalo-link`
9. Frontend nhỏ — thêm cột Zalo vào trang staff
10. Docs README + dev test script

## 10. Quyết định kỹ thuật & TODO sau MVP

### Đã chốt
- Access token đọc thẳng từ env, KHÔNG auto-refresh ở MVP
- Debounce: per `(staff_id, event_type)`, tối thiểu 60s (config được)
- PACKING_STARTED mặc định OFF, các cảnh báo khác ON khi `ZALO_NOTIFY_ENABLED=true`
- Gửi Zalo là side effect, **không await** trong response path của scan/clip
- Migration chỉ tạo file, **không** apply trực tiếp lên DB production
- 2 bảng mới enable RLS, **không** policy public → mọi truy cập đi qua server API

### TODO phase sau
- `zalo_oa_credentials` table + auto-refresh token khi 401/expired
- Multi-tenant: cú pháp `DK <ORG_SLUG> <CODE>` thay vì lookup global staff_code
- Signed public URL cho video clip (Zalo không yêu cầu login)
- pg_cron schedule cho `check_long_sessions` (hiện chỉ route, cần cron gọi)
- UI settings: toggle từng event per-org, không qua env
- Multi-channel: ngoài Zalo có thể thêm Telegram/Slack/email, mở rộng `notification_logs.channel`
- Test framework chính thức (vitest) + viết unit/integration test
- Rate limit theo IP cho webhook endpoint

## 11. Câu hỏi/đề xuất mở (cần xác nhận trước khi code)

1. **Video URL trong VIDEO_READY**: dùng deep-link `${APP_BASE_URL}/dashboard/order-proof?event=<id>` (yêu cầu login dashboard). Có chấp nhận không, hay cần public signed URL?
2. **Webhook lookup staff_code**: hiện chỉ 1 org → lookup global, assert duplicate. Đồng ý không?
3. **Permission `staff.zalo.view`** dành cho owner/admin/warehouse_manager; `staff.zalo.unlink` chỉ owner/admin. OK?
