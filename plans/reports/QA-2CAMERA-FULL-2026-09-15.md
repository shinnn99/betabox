# Báo cáo release-gate toàn hệ thống hai camera — 2026-09-15

## Kết luận

**KHÔNG ĐẠT — chưa được phát hành/vận hành kho thật.** Các phần lõi MediaMTX, FFmpeg, decoder, build TypeScript và phần trigger ghi hình theo ca đã chạy được, nhưng còn lỗi có thể chọn sai camera/sai agent, chuỗi migration không dựng được database sạch, test và ESLint chưa xanh, đồng thời các bước station live, remote live và ghép proof hai góc chưa được triển khai đầy đủ.

Lượt này chỉ kiểm thử và lập báo cáo; không sửa logic sản phẩm, không build `.exe`/installer và không lưu credential camera vào repo.

## Release gates

| Gate | Kết quả | Bằng chứng |
| --- | --- | --- |
| Root TypeScript | Đạt | `pnpm typecheck` exit 0 |
| Test TypeScript | Đạt | `pnpm typecheck:tests` exit 0 |
| Agent TypeScript | Đạt | `warehouse-agent: npm run typecheck` exit 0 |
| Agent tests | Đạt | 88/88 test |
| Root tests | Không đạt | 331/332; lỗi `tests/codec-invalidation.test.ts` |
| ESLint | Không đạt | 16 error, 51 warning |
| Production build | Đạt có cảnh báo | Build/TS/37 static pages thành công; cảnh báo NFT trace cả project từ `src/lib/camera/ffmpeg.ts` |
| Standalone smoke | Có điều kiện | Health/login/401 protected API đạt khi cấp `PLATFORM_ORG_CTX_SECRET` tạm; thiếu biến này thì middleware không khởi động |
| Migration clean bootstrap | Không đạt | `supabase start` dừng ở migration đầu tiên do revoke một function chưa tồn tại |
| 4 migration hai-camera độc lập | Đạt cú pháp | Apply thành công trên PostgreSQL fixture cô lập |
| SQL behavior theo ca | Đạt phần đã test | first-open start 2 camera; open thứ hai không lặp; final-close stop trễ ~60s; reopen hủy stop; scanner mode chỉ ghi primary |
| Camera LAN | Đạt đường media | Hikvision H.264 1280×720@25; Dahua HEVC 1920×1080@25 |
| MediaMTX → FFmpeg → QR decoder | Đạt smoke | 8/8 frame mỗi camera được relay và decoder xử lý |
| QR thật/replay dài hạn | Chưa nghiệm thu | Không có QR trong cảnh; chưa có bộ video kho ba ngày |

## Lỗi chặn phát hành

### P0-01 — Chuỗi migration không thể dựng database sạch

`supabase start` thất bại ngay tại `20260630041714_revoke_resolve_scanner_by_identity.sql`: migration gọi `REVOKE` trên `public.resolve_scanner_by_identity(uuid, jsonb)` trước khi function tồn tại. Vì vậy môi trường mới, CI database và disaster recovery không thể bootstrap từ repository.

### P0-02 — Start/stop recording thủ công có thể gửi sang agent của bàn khác

- `src/app/api/cameras/[id]/recording/start/route.ts:57-62`
- `src/app/api/cameras/[id]/recording/stop/route.ts:80-85`

Hai route chọn agent active có `last_seen_at` mới nhất trong toàn tổ chức, không dùng `cameras.agent_id`. Với nhiều agent trong một tổ chức, lệnh camera bàn A có thể tới máy bàn B. Điều này chưa đạt yêu cầu A.3.

### P0-03 — Luồng proof cũng có thể chọn sai agent

`src/app/api/order-proof/[pe_id]/watch/route.ts:197` gọi `readAgentLiveness` chỉ theo tổ chức rồi dùng agent đó để enqueue cut. Không khóa theo agent của camera hoặc segment. Badge liveness trong `src/lib/order-proof/service.ts` cũng dùng một agent chung cho toàn danh sách, nên trạng thái có thể sai giữa các bàn.

### P0-04 — Snapshot camera QR chọn nhầm góc quay

Trigger tại `supabase/migrations/20260914080000_two_cameras_logic_schema.sql:31-43` chọn camera active đầu tiên của station, không lọc assignment role `proof_qr`. Test SQL với overview tạo trước và QR tạo sau đã ghi `proof_qr_camera_id` bằng camera overview. Hậu quả: proof lịch sử có thể ghép sai video QR sau khi cấu hình bàn thay đổi.

## Lỗi mức cao

### P1-01 — Các bước chính của kiến trúc chưa tồn tại

14 artifact được tài liệu kiến trúc yêu cầu nhưng chưa có:

- `src/app/api/live/[stationId]/remote/route.ts`
- `src/app/api/live/media-auth/route.ts`
- `src/app/api/order-proof/[pe_id]/download/route.ts`
- `src/app/dashboard/station/page.tsx`
- `src/components/packing-stations/CameraConnectModal.tsx`
- `src/components/station/LiveLayout.tsx`
- `src/components/station/RemoteLiveModal.tsx`
- `src/components/station/StationNotifications.tsx`
- `supabase/verify/two_cameras_verify.sql`
- `warehouse-agent/src/compose/compose-plan.ts`
- `warehouse-agent/src/compose/encoder-detect.ts`
- `warehouse-agent/src/compose/font-extract.ts`
- `warehouse-agent/src/live/remote-publish.ts`
- `warehouse-agent/tests/compose-plan.test.ts`

Các field `qr_camera_id`, `angles_present`, `layout`, `progress_percent`, `label_check` hiện gần như chỉ có ở migration; chưa có pipeline cắt hai góc, compose PiP, progress và label-check hoàn chỉnh. C.1.3/C.1.4/C.1.5 và D.1 vẫn đang active/chờ.

### P1-02 — Gán camera/thiết bị không nguyên tử

`src/lib/camera/station-setup.ts` và `src/app/api/station-device-assignments/route.ts` thực hiện nhiều update/insert tuần tự ngoài transaction. Nếu bước tạo/move virtual scanner hoặc assignment sau lỗi, bước trước đã được ghi và API vẫn trả lỗi, để lại cấu hình bàn ở trạng thái dở dang. DELETE camera assignment cũng chưa chứng minh dọn assignment của `qrcam_<camera_code>` tương ứng.

### P1-03 — Hàng đợi proof offline thiếu tenant/agent identity

`order_proof_requests` chỉ có `order_id`, không có `organization_id`, `packing_event_id` hoặc `agent_id`; heartbeat đọc tối đa 10 request pending toàn hệ thống. Nếu hai tenant có dữ liệu/order mapping va chạm, request có thể bị agent khác claim theo dữ liệu của tenant đó. Bảng cũng chưa bật RLS (`relrowsecurity=false`). API hiện dùng service role và kiểm tra event theo org nên chưa chứng minh được đọc trực tiếp trái phép, nhưng mô hình dữ liệu chưa đủ an toàn cho multi-tenant/multi-agent.

### P1-04 — Quality gates đang đỏ

- Root test lỗi do `CONNECTION_FIELDS` đã có `rtsp_substream_path`, trong khi case “đổi cả 5 field” không truyền field đó nhưng lại kỳ vọng toàn bộ 6 field. Đây nhiều khả năng là test fixture lỗi thời, song CI vẫn đỏ.
- ESLint có 16 error: `ban-ts-comment` ở hai script test, `prefer-const`, 8 lỗi quote JSX, cập nhật ref trong render, thiếu định nghĩa custom rule signed-url và gọi `tick` trước khai báo.

## Tồn đọng/cảnh báo

- `supabase/migrations/20260723173403_add_evicted_status_to_clips.sql` là file rỗng; không có version migration trùng.
- Standalone production không chạy nếu thiếu `PLATFORM_ORG_CTX_SECRET` dài tối thiểu 32 ký tự. Smoke chỉ dùng giá trị tạm trong bộ nhớ, không ghi file.
- Build có cảnh báo output tracing kéo cả project qua chuỗi `next.config.ts` → `src/lib/camera/ffmpeg.ts` → camera test route; cần kiểm tra kích thước/đủ file khi deploy standalone.
- Agent QR frame phát cảnh báo FFmpeg `deprecated pixel format`; chưa gây fail frame nhưng nên theo dõi màu/range nếu dùng hình ảnh cho label check.
- Chưa nghiệm thu QR thật, debounce trong cảnh kho, 3-day replay, mất/reconnect WAN, hai máy agent vật lý đồng thời, remote VPS/WebRTC và compose/upload proof hai góc end-to-end.

## Phạm vi đã xác nhận hoạt động

- Hai camera LAN hiện truy cập được và decode đúng codec/resolution.
- MediaMTX packaged khởi động RTSP/WebRTC listener, kéo cả H.264 và H.265 on-demand.
- `QrFrameSource` và ZXing decoder không nghẽn trong smoke ngắn trên cả hai camera.
- Credential test không xuất hiện trong file workspace sau secret scan.
- Scan source gate có ở agent ingestion và manual/HID route; raw agent event vẫn được lưu nhưng không gọi RPC tạo đơn khi source bị khóa.
- Trigger shift migration cuối cùng định tuyến start/stop theo `camera.agent_id` trong các case SQL đã kiểm tra.
- Production build và các typecheck đều qua.

## Khuyến nghị thứ tự sửa

1. Sửa clean-bootstrap migration và thêm verify SQL bắt buộc trong CI.
2. Khóa mọi recording/proof command theo `camera.agent_id`/`camera_recording_files.agent_id`; thêm test hai agent cùng org.
3. Sửa trigger snapshot QR theo assignment role `proof_qr` và test đổi camera sau scan.
4. Bổ sung tenant/agent/event identity, RLS và claim nguyên tử cho `order_proof_requests`.
5. Transaction hóa toàn bộ move camera + virtual scanner.
6. Làm xanh root test và ESLint.
7. Hoàn thiện station live, remote live và pipeline PiP trước khi chạy E2E kho thật/replay ba ngày.

## Môi trường sau kiểm thử

- Container PostgreSQL QA tạm đã được xóa.
- Script smoke tạm đã được xóa.
- Dev UI đang chạy nền tại `https://localhost:3000/login` để người dùng xem trực tiếp; sử dụng HTTPS certificate tự ký của dự án.
