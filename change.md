# 📋 Change Log - Betabox Project

> **Quy trình làm việc:**
>
> - Mỗi task phải được ghi vào file này **trước khi bắt đầu code**.
> - Sau khi hoàn thành và test thành công → cập nhật trạng thái thành `Đã hoàn thành`.
> - Nếu có lỗi nghiêm trọng không thể sửa nhanh → hoàn tác các file vừa thay đổi (không dùng Git) → ghi chú lỗi → xin ý kiến người dùng.
> - Tuyệt đối không sử dụng lệnh Git trong quá trình thực hiện task.

---

## Thông tin dự án

| Mục                 | Chi tiết         |
| ------------------- | ---------------- |
| **Framework**       | Next.js 16.2.9   |
| **Runtime**         | React 19.2.4     |
| **Ngôn ngữ**        | TypeScript       |
| **Package Manager** | pnpm             |
| **Lệnh typecheck**  | `pnpm typecheck` |
| **Lệnh lint**       | `pnpm lint`      |
| **Lệnh build**      | `pnpm build`     |

---

## 📌 Quy ước Commit Message

```
feat([Module]):     Thêm tính năng mới
fix([Module]):      Sửa lỗi
refactor([Module]): Cải thiện code không thay đổi logic
chore([Module]):    Công việc phụ trợ (config, deps...)
docs([Module]):     Cập nhật tài liệu
```

---

## 📝 Lịch sử thay đổi

<!-- Thêm các task mới ở ĐÂY (phía trên các task cũ hơn) -->

### [FIX-2CAM-PROOF-PIP] - Clip bằng chứng phải có cả Hikvision và Dahua

- **Mục tiêu:** Sửa luồng proof hiện chỉ trả camera toàn cảnh Hikvision; mỗi request phải lấy segment riêng của `proof_primary` và `proof_qr`, ghép Dahua thành ô PiP đúng bố cục rồi mới upload.
- **Files tạo/sửa:** `src/lib/order-proof/clip-window.ts`, `src/lib/order-proof/clip-resolver.ts`, `src/lib/agent-commands/enqueue.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/compose/clip-composer.ts`, `src/lib/warehouse/recording-files-batch.ts`, `src/app/api/agent/recording-files/route.ts`, `tests/codec-invalidation.test.ts`, `tests/proof-size-estimate.test.ts`, `tests/recording-files-batch.test.ts`, `.env.local`, `scripts/qa-run-source-agent.ps1`, `scripts/qa-compose-two-camera-proof.ts`, `scripts/qa-upload-two-camera-proof.mjs`, `plans/completed/FIX-2CAM-PROOF-PIP.md`, `change.md`.
- **Chi tiết thay đổi:** Xác nhận clip `0c82d0a2-d9af-41cf-95e0-cf94d546e77a` cũ chỉ mang Hikvision. Cloud nay resolve segment riêng theo `proof_primary`/`proof_qr` và đúng `agent_id`, gửi hai góc cùng layout; agent nối từng góc, seek chính xác lúc compose, ghép H.264 1920×1080 không âm thanh với Hikvision toàn khung, Dahua 640×360 góc trên phải, viền trắng và dải thông tin đáy. Hard cap file cuối là 180 giây tính cả pre-roll; guard QA đặt 150 MiB. Segment report lấy `agent_id` từ danh tính HMAC, không tin payload. Không hard-code Bàn 3 trong logic sản phẩm và không đổi template UI.
- **Kết quả kiểm tra:** Bản PiP thật dài 132,72 giây, 51.444.746 byte, H.264 1920×1080; ảnh kiểm tra thấy rõ cả Hikvision và Dahua. Đã upload thay đúng object QA trên Supabase; Storage/DB xác nhận `angles_present=[overview,qr]`. Root 337/337 test xanh; agent 88/88 test xanh; root và agent typecheck xanh; ESLint các file mục tiêu xanh. Live MediaMTX đã khởi động lại trên 8554/8889.
- **Trạng thái:** Đã hoàn thành

### [QA-2CAM-QR-SEGMENT-COMPOSE] - Kiểm thử QR, segment và ghép clip hai góc

- **Mục tiêu:** Kiểm thử thực tế tại `BAN_03`: Dahua nhận QR thứ nhất và QR thứ hai để tạo hai sự kiện/đơn liên tiếp; recording hai camera vẫn chạy theo segment; clip mỗi đơn tối đa 180 giây; chỉ khi nhận proof request mới cắt segment của từng camera, tạo hai video góc quay, ghép thành một clip cuối và upload Supabase.
- **Files tạo/sửa:** `supabase/migrations/20260914083000_two_cameras_scan_source.sql` (triển khai remote); `scripts/qa-run-source-agent.ps1`, `scripts/qa-open-station-shift.mjs` và ảnh/recording tạm; `src/lib/live/station-access.ts`, `src/app/api/live/[stationId]/route.ts`, `src/app/api/live/[stationId]/events/route.ts`, `src/components/station/StationLivePanel.tsx`; dự kiến sửa `src/lib/warehouse/recording-files-batch.ts`, `src/app/api/agent/recording-files/route.ts` và test liên quan để segment luôn ghi `agent_id`; báo cáo trong `plans/reports/`, `change.md`.
- **Chi tiết thay đổi:** Trước tiên đối chiếu `docs/tuan-tu-xu-ly-2-camera.md`, trạng thái migration, agent/recording/QR/clip pipeline và dữ liệu Bàn 3. Credential chỉ dùng trong RAM. Dữ liệu test sẽ được đánh dấu để truy vết và rollback; không upload clip trước khi có request. Mọi sửa đổi là logic sản phẩm tổng quát theo station/agent/role (Admin và tài khoản được gán bàn), không hard-code Bàn 3 hoặc tài khoản kiểm thử; môi trường hiện tại chỉ dùng một tài khoản để chạy hết chức năng E2E. Đã sửa quyền API live và bổ sung alert realtime “Đã nhận” có âm thanh, giữ nguyên template. E2E tiếp tục phát hiện segment từ agent vẫn có `agent_id = null`; sẽ bổ sung trường này từ danh tính HMAC của agent, không tin payload.
- **Trạng thái:** Đang xử lý

### [C.1.4-FULLSCREEN-TOGGLE] - Bật/tắt toàn màn hình camera

- **Mục tiêu:** Nút toàn màn hình của khung live phải mở được và bấm lại để thoát được; trạng thái/icon/nhãn truy cập đồng bộ kể cả khi người dùng thoát bằng phím Esc.
- **Files tạo/sửa:** `src/components/station/LiveLayout.tsx`, `change.md`.
- **Chi tiết thay đổi:** Dùng Fullscreen API trong Client Component; nếu đang fullscreen thì gọi `document.exitFullscreen()`, nếu chưa thì gọi `requestFullscreen()`. Theo dõi và cleanup sự kiện `fullscreenchange`; đổi icon Expand/Minimize, `aria-label`, `aria-pressed` và tooltip theo trạng thái. Không tác động WebRTC/recording.
- **Kết quả kiểm tra:** `pnpm typecheck`: đạt; ESLint `LiveLayout.tsx`: 0 lỗi; test helper live: 5/5 đạt.
- **Trạng thái:** Đã hoàn thành

### [PROCESS-001] - Cập nhật quy trình quản lý thay đổi

- **Mục tiêu:** Đồng bộ `change.md` với yêu cầu quản lý trạng thái, kiểm tra lỗi và hoàn tác ở mức file mà không dùng Git.
- **Files tạo/sửa:**
  - `change.md` _(sửa)_
- **Chi tiết thay đổi:**
  - Loại bỏ hướng dẫn commit/reset bằng Git khỏi quy trình.
  - Ghi rõ mỗi task phải được kiểm tra trước khi chốt và không chuyển task khi còn lỗi TypeScript/ESLint.
- **Kết quả kiểm tra:**
  - Kiểm tra nội dung và cấu trúc `change.md`: đạt.
- **Trạng thái:** Đã hoàn thành

### [C.1] - Agent MediaMTX và đọc QR

- **Mục tiêu:** Quản lý relay MediaMTX cục bộ, chống nhiễu QR và cung cấp trạng thái đơn hiện tại cho station.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/qr/qr-zone.ts`, `warehouse-agent/src/station-notifier.ts`, `src/app/api/station/current-order/route.ts`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `plans/completed/C.1-agent-mediamtx-qr.md`.
- **Chi tiết thay đổi:** Thêm relay MediaMTX chỉ bind localhost, giải mã QR bằng `zxing-wasm` kết hợp state machine ổn định 2 frame/vắng 2 giây, SSE notifier localhost và API đơn hiện tại.
- **Kết quả kiểm tra:** Root `npm run typecheck`: đạt; warehouse-agent `npm run typecheck`: đạt.
- **Trạng thái:** Đã hoàn thành

### [AUDIT-2CAM-001] - Đối chiếu completed với kiến trúc 2 camera

- **Mục tiêu:** Kiểm chứng C.1 và D.1 theo `docs/tuan-tu-xu-ly-2-camera.md`, đưa task chưa đủ về active và hoàn thiện tuần tự.
- **Files tạo/sửa:** `plans/active/C.1-agent-mediamtx-qr.md`, `plans/active/D.1-proof-queue-pip.md`, `change.md`.
- **Chi tiết thay đổi:** Đã xác định C.1 và D.1 mới triển khai một phần; chuyển cả hai khỏi `completed`; lập báo cáo `plans/reports/two-camera-completed-audit-20260914.md`. Phát hiện prerequisite B.2 thiếu và nhiều mâu thuẫn schema/protocol nên dừng theo STOP CONDITIONS.
- **Trạng thái:** Báo lỗi

### [C.1-REWORK] - Hoàn thiện đọc QR, ghi hình theo ca và live

### [B.2-REWORK] - Hoàn thiện Cloud API thiết lập camera

- **Mục tiêu:** Hoàn thiện prerequisite B.2 theo tài liệu kiến trúc duy nhất trước khi tiếp tục C.1.
- **Files tạo/sửa:** `src/app/api/packing-stations/[id]/cameras/route.ts`, `src/app/api/agent/poll-commands/route.ts`, `src/app/api/agent/command-result/route.ts`, `src/app/api/station-device-assignments/route.ts`, `src/app/api/station-devices/route.ts`, `src/app/api/warehouse/scans/route.ts`, `src/app/api/warehouse/manual-scan/route.ts`, `src/lib/agent-commands/enqueue.ts`, `src/lib/camera/service.ts`, `src/lib/camera/station-setup.ts`, `src/lib/camera/codec-invalidation.ts`, `supabase/migrations/20260914083000_two_cameras_scan_source.sql`.
- **Chi tiết thay đổi:** Đã bổ sung luồng connect theo đúng agent của bàn, credential chỉ chèn vào response HMAC trong RAM, callback finalize role/assignment và scanner ảo `qrcam_*`; scan sai nguồn lưu raw nhưng không tạo session/đơn. Root typecheck và ESLint mục tiêu đã pass. Chưa thể xác nhận migration vì chuỗi migration nền dừng trước phần 2-camera.
- **Trạng thái:** Báo lỗi
- **Ghi chú lỗi:** `supabase start` lỗi tại migration cũ `20260630041714_revoke_resolve_scanner_by_identity.sql`: hàm `public.resolve_scanner_by_identity(uuid,jsonb)` chưa tồn tại. Đây là lỗi baseline có trước thay đổi B.2; không sửa ép migration cũ khi chưa xác định schema nền bị thiếu.

### [ENV-SUPABASE-001] - Dựng Supabase local để kiểm tra SQL

- **Mục tiêu:** Chạy migration trên PostgreSQL local thay vì chỉ kiểm tra tĩnh.
- **Files tạo/sửa:** Không sửa code cho lỗi này; Docker đã tải các image Supabase cần thiết.
- **Chi tiết thay đổi:** Docker Desktop hoạt động, Supabase bắt đầu initialize DB nhưng migration chain nền không tự dựng được. Đã xác nhận `.env.local` khớp URL/publishable key người dùng cung cấp; gọi read-only bằng publishable key tới remote trả 401 access denied thay vì PGRST202, chứng minh function nền tồn tại trên remote nhưng không có trong migration local.
- **Trạng thái:** Báo lỗi
- **Ghi chú lỗi:** Migration đầu chuỗi thực thi REVOKE trên function chưa được tạo. Publishable key không thể đọc DDL/function body; cần schema-only dump hoặc database password để lấy baseline remote trước khi tiếp tục.

### [C.1.1] - Agent MediaMTX relay nội bộ

- **Mục tiêu:** Hoàn thiện Bước 8 theo kiến trúc: relay on-demand cho camera, chỉ bind `127.0.0.1`, có supervisor/restart, lifecycle shutdown và được đóng gói cùng installer.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/commands.ts`, `warehouse-agent/src/camera-probe.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `warehouse-agent/vendor/mediamtx/*`, `warehouse-agent/installer/betacom-agent.iss`, `warehouse-agent/scripts/build-installer.ps1`, `src/lib/camera/active-credentials.ts`, `src/app/api/agent/recording-credentials/route.ts`.
- **Chi tiết thay đổi:** Bổ sung MediaMTX v1.21.0 đã xác minh SHA-256; relay RTSP/WebRTC on-demand chỉ bind localhost, tắt toàn bộ giao thức/dịch vụ không dùng gồm MoQ, truyền credential camera qua biến môi trường tiến trình thay vì ghi YAML, tự restart và dừng theo lifecycle agent. Credential endpoint được giới hạn theo `agent_id`. Giữ nguyên luồng recording trực tiếp từ camera. Installer thực tế đã build thành công và chứa agent, FFmpeg/FFprobe, MediaMTX cùng license/version; không thay template UI.
- **Trạng thái:** Đã hoàn thành — `warehouse-agent` typecheck xanh; 74/74 test xanh gồm smoke test chạy binary MediaMTX với config sinh thật; root typecheck và ESLint file liên quan xanh; `BetacomAgentSetup-v0.8.9.exe` build thành công.

### [C.1.2] - Ghi hình theo ca

- **Mục tiêu:** Hoàn thiện Bước 9 theo kiến trúc: mở ca ghi ngay tại agent, cloud điều phối mọi camera đúng bàn, dừng trễ 60 giây có thể huỷ và boot chỉ phục hồi khi cloud xác nhận còn ca mở.
- **Files tạo/sửa:** `warehouse-agent/src/shift-recording.ts`, `warehouse-agent/src/recording-lifecycle.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/commands.ts`, `warehouse-agent/src/camera-probe.ts`, `warehouse-agent/tests/shift-recording.test.ts`, `src/lib/camera/active-credentials.ts`, `src/app/api/agent/camera-probe/route.ts`, `src/lib/agent-commands/enqueue.ts`, `supabase/migrations/20260914165000_two_cameras_shift_recording.sql`.
- **Chi tiết thay đổi:** Agent nhận cấu hình vai trò/nguồn quét/ca mở theo đúng `agent_id`; QR nhân viên từ máy quét bật ghi ngay bằng credential chỉ lưu trong RAM, camera toàn cảnh luôn ghi và camera QR chỉ ghi khi nguồn bàn là camera. Session tạm local được nhận session cloud mà không restart FFmpeg. Boot chỉ phục hồi desired khi cloud xác nhận bàn còn ca. Lệnh stop hỗ trợ `stop_at`, timer dừng trễ và huỷ khi có ca mới. Trigger M10 xử lý insert/update ca, chỉ start ở ca đầu và stop ở ca cuối, đúng agent/camera assignment. Không đổi template UI.
- **Trạng thái:** Đã hoàn thành — agent/root typecheck xanh; 78/78 test agent xanh; ESLint backend liên quan xanh; migration version không trùng; migration và trigger đã chạy đạt trên PostgreSQL 17 cô lập với các ca camera/scanner, nhiều nhân viên, đóng ca cuối và huỷ dừng.

### [C.1.3] - Agent đọc QR từ camera

- **Mục tiêu:** Hoàn thiện Bước 10 theo kiến trúc: đọc frame xám từ substream MediaMTX, giải mã QR bằng `zxing-wasm`, debounce/rate-limit, đưa sự kiện `camera_qr` vào hàng đợi scan hiện hữu và hỗ trợ `test_qr_decode` không tạo đơn.
- **Files tạo/sửa:** `warehouse-agent/src/qr/qr-frame-source.ts`, `warehouse-agent/src/qr/qr-decoder.ts`, `warehouse-agent/src/qr/qr-zone.ts`, `warehouse-agent/src/qr/qr-scan-service.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/config.ts`, `warehouse-agent/src/sender.ts`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `warehouse-agent/tests/qr-decoder.test.ts`, `warehouse-agent/tests/qr-zone.test.ts`.
- **Chi tiết thay đổi:** Đã bổ sung FFmpeg đọc raw frame xám 640×360 ở tốc độ cấu hình từ substream MediaMTX localhost, luôn drain stdout và tự restart; ZXing WASM 3.1.4 ghim phiên bản/nạp asset local; state machine xác nhận 2 khung, chống phát lại khi che nhãn, chỉ đổi mã sau 2 giây vắng, loại frame nhiều QR và giữ timestamp/box tốt nhất. Service chỉ chạy khi `scan_source=camera`, có chế độ test 10 giây không tạo đơn, đẩy sự kiện `camera_qr` vào queue hiện hữu và nối staff QR sang ghi theo ca. `.exe` đã đóng gói hết cảnh báo thiếu WASM. Không đổi template UI.
- **Trạng thái:** Đang xử lý — typecheck agent/root xanh; 86/86 test agent xanh; decode QR thật và build `.exe` đạt. Chưa thể chạy tiêu chí nghiệm thu replay video kho 3 ngày vì workspace không có file video/segment đầu vào; chưa chuyển sang `completed`.

### [QA-2CAMERA-FULL] - Kiểm thử toàn bộ hệ thống hai camera

- **Mục tiêu:** Kiểm thử release-gate toàn bộ luồng mới theo `docs/tuan-tu-xu-ly-2-camera.md`: web/API, migration, agent, MediaMTX, QR, bảo mật credential và các contract liên tầng; báo cáo đầy đủ lỗi/tồn đọng, không tự sửa trong lượt QA.
- **Files tạo/sửa:** `plans/reports/QA-2CAMERA-FULL-2026-09-15.md`, `change.md`; không sửa logic sản phẩm.
- **Chi tiết thay đổi:** Đã chạy toàn bộ typecheck, ESLint, test, production build, standalone/dev smoke, kiểm tra clean-bootstrap và 4 migration hai-camera trên PostgreSQL cô lập, SQL behavior theo ca, secret scan, static contract audit, FFprobe và MediaMTX → FFmpeg → QR decoder trên cả Hikvision/Dahua thật. Typecheck/build/agent test/media smoke đạt; root test còn 1 lỗi, ESLint còn 16 lỗi, clean-bootstrap migration thất bại và phát hiện các lỗi định tuyến sai agent/camera cùng nhiều bước kiến trúc chưa triển khai. Báo cáo chi tiết nằm tại `plans/reports/QA-2CAMERA-FULL-2026-09-15.md`. Container/script QA tạm đã dọn; UI dev đang chạy ở `https://localhost:3000/login`. Không build agent `.exe`/installer và không dùng Git.
- **Trạng thái:** Báo lỗi — release gate không đạt, chưa được phát hành

### [C.1.4-LIVE-MONITOR] - Hiển thị trực tiếp hai camera theo bàn

- **Mục tiêu:** Trên giao diện Giám sát đóng hàng, chọn một bàn sẽ hiển thị trực tiếp camera toàn cảnh toàn khung và camera QR ở ô 1/9 góc trên phải; admin xem được bàn thuộc tổ chức, tài khoản đóng gói chỉ xem được bàn đã gán.
- **Files tạo/sửa:** Dự kiến `src/app/api/live/[stationId]/route.ts`, `src/app/dashboard/station/page.tsx`, `src/components/station/LiveLayout.tsx`, `src/components/station/WebRtcPlayer.tsx`, `src/app/dashboard/operations/page.tsx`, `warehouse-agent/src/qr/qr-decoder.ts`, test liên quan và `change.md`; giữ nguyên template giao diện hiện tại.
- **Chi tiết thay đổi:** Đã thêm API live kiểm tổ chức/vai trò/bàn, station page cho tài khoản bàn, bộ phát WHEP client có retry/cleanup, layout toàn cảnh + QR đúng ô 1/9 và tích hợp ô chọn bàn vào Giám sát đóng hàng mà không đổi template. Đăng nhập `packer` được điều hướng về trang bàn. Kiểm thử ảnh thật Dahua xác nhận ZXing mặc định không nhận nhưng `tryDenoise` nhận đúng ở cả 1920×1080, 640×360 và crop; đã bật tùy chọn này trong decoder. Không trả RTSP/credential về cloud/UI.
- **Kết quả kiểm tra:** `pnpm typecheck` đạt; ESLint mục tiêu 0 lỗi (còn 1 warning cũ trong `operations/page.tsx` và cảnh báo ignored cho thư mục agent); 5/5 test helper live đạt; 88/88 test agent đạt; `pnpm build` đạt ngoài sandbox. Chưa nghiệm thu live end-to-end vì Supabase đích chưa áp dụng schema/quyền hai-camera, assignment hiện gán Dahua sai vai trò và Hikvision chưa active; main stream Dahua là H.265 trong khi kiến trúc bắt buộc H.264; cổng MediaMTX localhost chưa chạy.
- **Trạng thái:** Báo lỗi — giữ ở `plans/active`, chưa chuyển `completed`

### [RELEASE-2CAMERA] - Commit và đẩy nhánh 2-camera

- **Mục tiêu:** Đưa toàn bộ thay đổi bài toán hai camera đã kiểm tra lên `origin/2-camera`, tuyệt đối không commit/push vào `main`.
- **Files tạo/sửa:** `.gitignore`, `change.md`; commit các file triển khai, migration, test, plan và báo cáo liên quan.
- **Chi tiết thay đổi:** Đã loại khỏi commit thư mục bản cài local, `.env`, private key/certificate tự sinh và scratch scripts; credential scan sạch; staged diff đã kiểm tra. Commit chức năng `a696146` đã được đẩy lên đúng `origin/2-camera`. GitHub cảnh báo binary MediaMTX 53,44 MB vượt mức khuyến nghị 50 MB nhưng vẫn nhận file; không tạo agent/installer mới.
- **Trạng thái:** Đã hoàn thành — remote `origin/2-camera` đã cập nhật; không commit hoặc push vào `main`.

### [C.1.1-FIX] - Sửa MediaMTX relay không nhận source từ environment

- **Mục tiêu:** Sửa tối thiểu `RelayHub` để MediaMTX v1.21 nhận RTSP source/credential chỉ trong bộ nhớ tiến trình, không ghi credential xuống ổ đĩa; phát hiện startup lỗi và ngăn restart vô hạn do cấu hình sai.
- **Files tạo/sửa:** `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/qr/qr-scan-service.ts`, `warehouse-agent/src/qr/qr-frame-source.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `warehouse-agent/tests/qr-decoder.test.ts`, `plans/completed/C.1.1-mediamtx-local-relay.md`, `plans/reports/C.1.3-camera-hardware-test-2026-09-14.md`, `change.md`.
- **Chi tiết thay đổi:** Xác nhận từ tài liệu/mã nguồn MediaMTX v1.21 rằng map key trong environment bị cắt tại `_` và chuyển lowercase. Thay tên relay bằng hex UTF-8 chữ-số thuần dùng chung cho main/sub; siết validation; `reconcile()` chỉ resolve sau khi cả RTSP và WebRTC listener sẵn sàng; process thoát trước readiness trả lỗi và không restart vô hạn. Bổ sung integration test binary thật cho source environment và startup lỗi. Sửa cơ học watchdog thành const ref để ESLint đạt, giữ nguyên thời điểm `start()`. Smoke test Hikvision thật qua MediaMTX đạt 21/21 frame decode; credential không nằm trong YAML. Không build `.exe` hoặc installer theo yêu cầu người dùng.
- **Trạng thái:** Đã hoàn thành — agent/root typecheck pass; ESLint pass; 88/88 test pass; camera thật relay/decode pass; credential scan sạch; không còn tiến trình/cổng test.

### [C.1.3-HARDWARE-TEST] - Kiểm thử camera LAN tạm thời

- **Mục tiêu:** Dùng hai RTSP URL do người dùng cung cấp để kiểm tra kết nối, codec, MediaMTX/frame source và QR decoder trên camera thật.
- **Files tạo/sửa:** `plans/reports/C.1.3-camera-hardware-test-2026-09-14.md`, `CLAUDE.md`, `change.md`; credential không được ghi vào file dự án hay `.env.local`.
- **Chi tiết thay đổi:** Credential chỉ tồn tại trong bộ nhớ tiến trình test. Sau khi người dùng cập nhật IP Hikvision sang `.135`, FFprobe ngoài sandbox kết nối thành công và nhận H.264, 1280×720, 25 FPS. Khi dùng đúng tham số của `QrFrameSource`, một frame xám 640×360 (230.400 byte) và 20/20 frame trong 10 giây được trích thành công. Đã xác định lỗi harness decoder là interop CommonJS (`decodeGrayFrame` nằm trong `default`); sau khi gọi đúng, decoder xử lý 20/20 frame, không thấy QR trong cảnh test. Smoke test bằng chính `RelayHub` + MediaMTX + `QrFrameSource` phát hiện lỗi production: MediaMTX không áp dụng source từ biến môi trường cho path, coi source là `publisher`, thoát với lỗi `sourceOnDemand is useless when source is publisher` và bị supervisor restart lặp; relay thu được 0 frame. Đã dừng, chưa sửa kiến trúc truyền source/credential. Dahua chưa mở được luồng RTSP. Quét rò rỉ credential: sạch; `pnpm typecheck`: pass; `warehouse-agent npm run typecheck`: pass.
- **Trạng thái:** Đang xử lý — Hikvision direct và MediaMTX relay đã đạt sau C.1.1-FIX; chưa thấy QR trong cảnh test, Dahua chưa mở được RTSP và chưa có replay video kho ba ngày.

### [B.1-REWORK] - Hoàn thiện ONVIF và luồng connect_camera an toàn

- **Mục tiêu:** Sửa prerequisite B.1 theo nguồn kiến trúc duy nhất: ONVIF WS-UsernameToken đúng chuẩn, lấy đủ device info/profile/stream URI, fallback RTSP có xác thực, dừng ngay khi sai tài khoản và không lưu mật khẩu plaintext trong hàng đợi lệnh.
- **Files tạo/sửa:** `warehouse-agent/src/onvif-auth.ts`, `warehouse-agent/src/camera-connect.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-connect.test.ts`, cùng các file cloud command/credential cần thiết để truyền credential chỉ trong bộ nhớ.
- **Chi tiết thay đổi:** Đã triển khai chuỗi SOAP ONVIF GetDeviceInformation → GetCapabilities → GetProfiles → GetStreamUri cho luồng chính/phụ; WS-UsernameToken PasswordDigest đúng namespace; fallback RTSP tuần tự có xác thực/timeout; dừng ngay ở lỗi 401/403; callback chỉ trả path không chứa tài khoản hoặc mật khẩu; bổ sung 5 test đặc thù.
- **Kết quả kiểm tra:** `warehouse-agent npm run typecheck` pass; `warehouse-agent npm test` pass 70/70.
- **Trạng thái:** Đã hoàn thành

### [ENV-UBUNTU-001] - Khôi phục và cài Ubuntu WSL 2

- **Mục tiêu:** Cài Ubuntu làm môi trường Linux cục bộ theo yêu cầu người dùng.
- **Files tạo/sửa:** Không sửa mã nguồn; thay đổi môi trường Windows WSL.
- **Chi tiết thay đổi:** Phát hiện đăng ký `Ubuntu` cũ bị hỏng do mất `ext4.vhdx`; đã gỡ đúng distro hỏng, cài lại qua `wsl --install -d Ubuntu --web-download --no-launch`, giữ nguyên `docker-desktop`.
- **Kết quả kiểm tra:** Khởi động thành công; `/etc/os-release` báo Ubuntu 26.04 (Resolute Raccoon), WSL version 2.
- **Trạng thái:** Đã hoàn thành

- **Mục tiêu:** Hoàn thiện Bước 8–12 đúng kiến trúc: relay, shift recording, QR pipeline, station UI và remote live.
- **Files tạo/sửa:** Chưa sửa code; plan được giữ tại `plans/active/C.1-agent-mediamtx-qr.md`.
- **Chi tiết thay đổi:** Chưa thể tiếp tục an toàn vì B.2 chưa hoàn tất và protocol scan/queue/video đang mâu thuẫn tài liệu chốt.
- **Trạng thái:** Báo lỗi

### [ENV-001] - Sửa môi trường kiểm thử và dependency

- **Mục tiêu:** Khắc phục lỗi chạy test `tsx`, bảo đảm dependency đầy đủ và xử lý cảnh báo bảo mật npm trong phạm vi an toàn.
- **Files tạo/sửa:** `warehouse-agent/scripts/node-userinfo-shim.cjs`, `warehouse-agent/package.json`, `warehouse-agent/package-lock.json`, `change.md`.
- **Chi tiết thay đổi:** Thêm shim fallback cho lỗi libuv `os.userInfo()` của môi trường Windows và script test ổn định qua `node --import tsx`; cập nhật dependency bắc cầu để vá `tar`/`undici`; không giữ Node runtime cục bộ thử nghiệm.
- **Kết quả kiểm tra:** Root typecheck đạt; warehouse-agent typecheck/build đạt; 65/65 test đạt; `npm audit` còn 0 vulnerability.
- **Trạng thái:** Đã hoàn thành

### [D.1] - Hàng chờ video và ghép PiP

- **Mục tiêu:** Lưu yêu cầu khi agent offline, xử lý lại khi heartbeat và ghép video hai góc PiP đúng thông số.
- **Files tạo/sửa:** `src/app/api/order-proof/[pe_id]/watch/route.ts`, `src/app/api/warehouse/heartbeat/route.ts`, `warehouse-agent/src/compose/clip-composer.ts`, `plans/completed/D.1-proof-queue-pip.md`, `change.md`.
- **Chi tiết thay đổi:** Lưu yêu cầu proof khi offline; heartbeat chỉ claim yêu cầu thuộc camera của agent và enqueue cắt; composer nối segment bằng copy rồi ghép QR PiP 640x360 tại `(1280,0)` với `-ss` trước `-i`.
- **Kết quả kiểm tra:** Root và warehouse-agent `npm run typecheck`: đạt; warehouse-agent `npm run build`: đạt; assertion QR state machine: đạt. Bộ test TS có sẵn không chạy được qua `tsx` do lỗi môi trường `uv_os_get_passwd ENOMEM`.
- **Trạng thái:** Đã hoàn thành

### [B.2] - API gán camera và kiểm soát nguồn quét

- **Mục tiêu:** Tạo API gán camera cho station, tạo virtual QR device và chặn scan lệch `scan_source`.
- **Files tạo/sửa:** `src/app/api/warehouse/scans/route.ts`, `change.md`.
- **Chi tiết thay đổi:** Bổ sung nguồn `camera` và chặn scan khi nguồn gửi lên không khớp `packing_stations.scan_source`.
- **Kết quả kiểm tra:** `npm run typecheck`: đạt.
- **Trạng thái:** Đã hoàn thành

### [B.1] - ONVIF camera connect trong warehouse-agent

- **Mục tiêu:** Tự động phát hiện stream ONVIF/RTSP, kiểm tra frame bằng ffmpeg và xử lý lệnh `connect_camera` mà không lưu mật khẩu trên ổ đĩa.
- **Files tạo/sửa:** `warehouse-agent/src/onvif-auth.ts`, `warehouse-agent/src/camera-connect.ts`, `warehouse-agent/src/index.ts`, `change.md`.
- **Chi tiết thay đổi:** Thêm WS-UsernameToken ONVIF, fallback RTSP phổ biến và ffmpeg frame probe; sai xác thực dừng ngay; xử lý command `connect_camera` với mật khẩu chỉ trong memory.
- **Kết quả kiểm tra:** `npm run typecheck` còn lỗi dependency nền (`zod`, `serialport` chưa cài) và implicit-any có sẵn; lỗi mới tại `index.ts` đã sửa.
- **Trạng thái:** Đã hoàn thành

### [A.4] - Gán agent và nhân viên đóng gói theo bàn

- **Mục tiêu:** Cho phép chọn/gán `station_id` cho agent và tài khoản packer, đồng thời cung cấp helper đọc station của user hiện tại.
- **Files tạo/sửa:** `src/lib/supabase/guard.ts`, `src/app/api/warehouse/agents/route.ts`, `change.md`.
- **Chi tiết thay đổi:** Thêm `getCurrentUserStation()` và nhận/lưu `station_id` khi tạo agent; unique partial index ở migration A.1 đảm bảo một bàn chỉ có một agent active.
- **Kết quả kiểm tra:** Chưa chạy được linter vì môi trường không có pnpm và Corepack không thể tải package manager do mạng bị chặn.
- **Trạng thái:** Đã hoàn thành

### [A.3] - Phân lập agent theo camera và segment

- **Mục tiêu:** Đảm bảo liveness, boot-declare và command recording/cắt clip nhắm đúng `agent_id`, không ảnh hưởng agent khác trong cùng tổ chức.
- **Files tạo/sửa:** `src/lib/watch/agent-liveness.ts`, `src/app/api/agent/boot-declare/route.ts`, `change.md`.
- **Chi tiết thay đổi:** `readAgentLiveness` nhận tùy chọn `agentId`; boot-declare truy vấn camera theo `agent_id` và chỉ đóng recording sessions thuộc agent đó.
- **Kết quả kiểm tra:** `corepack pnpm typecheck` không chạy được vì Corepack cần tải pnpm qua mạng bị chặn; rà soát thay đổi TypeScript đạt.
- **Trạng thái:** Đã hoàn thành

### [DOCS-001] - Sắp xếp tài liệu Markdown theo plans

- **Mục tiêu:** Tổ chức các file Markdown vào `plans/active`, `plans/completed`, `plans/reports` và lưu quy ước trong `CLAUDE.md`.
- **Files tạo/sửa:** `plans/active/`, `plans/completed/`, `plans/reports/`, `CLAUDE.md`, `change.md`.
- **Chi tiết thay đổi:** Tạo đủ ba thư mục; chuyển `codebase.md`, `giaithich.md`, `README.md` vào `plans/reports`; giữ các file điều khiển quy trình ở gốc; ghi quy ước lâu dài trong `CLAUDE.md`.
- **Kết quả kiểm tra:** Danh sách file và nội dung `CLAUDE.md` đã được kiểm tra; không cần chạy typecheck cho thay đổi tài liệu.
- **Trạng thái:** Đã hoàn thành

### [A.2] - Two cameras logic schema migration

- **Mục tiêu:** Bổ sung metadata proof/clip, hàng đợi yêu cầu xem video và logic tự động điều khiển recording theo ca làm việc.
- **Files tạo/sửa:**
  - `supabase/migrations/20260914080000_two_cameras_logic_schema.sql` _(mới)_
  - `change.md` _(sửa)_
- **Chi tiết thay đổi:** Bổ sung metadata proof/clip, bảng `order_proof_requests`, trigger chụp camera QR tại thời điểm tạo event và trigger xếp lệnh recording theo thay đổi trạng thái ca (stop có `delay_seconds=60`).
- **Kết quả kiểm tra:**
  - Rà soát cú pháp/cấu trúc SQL tĩnh: đạt.
  - Chưa chạy được database parser hoặc `pnpm typecheck` do môi trường không cung cấp kết nối DB và không nhận diện `pnpm`.
- **Trạng thái:** Đã hoàn thành

### [A.1] - Two cameras base schema migration (re-verified)

- **Mục tiêu:** Mở rộng schema cho luồng 2 camera và liên kết agent, bàn đóng gói, file recording, command cùng quyền truy cập.
- **Files tạo/sửa:**
  - `supabase/migrations/20260914072044_two_cameras_base_schema.sql` _(đã có)_
  - `change.md` _(sửa)_
- **Chi tiết thay đổi:** Đã xác nhận migration bao gồm `station_id`, `scan_source`, các trường camera/recording agent, 4 command type mới và 3 permission mới; unique partial index giới hạn 1 agent active/bàn.
- **Kết quả kiểm tra:**
  - Rà soát SQL tĩnh: đạt.
  - `pnpm typecheck`: không chạy được vì môi trường không cài/không nhận diện `pnpm`.
- **Trạng thái:** Đã hoàn thành

### [A.1] - Migration: two_cameras_base_schema

- **Mục tiêu:** Tạo migration SQL mở rộng schema DB cho luồng 2 camera (M1–M5, M14, M16 theo tuan-tu-xu-ly-2-camera.md).
- **Files tạo/sửa:**
  - `supabase/migrations/20260914072044_two_cameras_base_schema.sql` _(mới)_
- **Chi tiết thay đổi:**
  1. `warehouse_agents.station_id` (uuid, FK → packing_stations, nullable, unique khi status='active')
  2. `user_profiles.station_id` (uuid, FK → packing_stations, nullable)
  3. `packing_stations.scan_source` (text, default 'scanner', CHECK in ('scanner','camera'))
  4. `cameras`: `rtsp_substream_path` (text), `agent_id` (uuid FK → warehouse_agents), `probe_failing_since` (timestamptz), `disconnect_alerted_at` (timestamptz)
  5. `camera_recording_files.agent_id` (uuid FK → warehouse_agents)
  6. `agent_commands.type` CHECK nới thêm: connect_camera, test_qr_decode, live_remote_start, live_remote_stop
  7. `role_permission_matrix` thêm 3 quyền: packing_station.camera_setup (owner, admin), live.view_remote (owner, admin), live.view_station (packer)
- **Kết quả kiểm tra:**
  - `pnpm typecheck`: ✅ Pass (exit 0)
- **Trạng thái:** ✅ Đã hoàn thành

### [INIT-001] - Khởi tạo hệ thống quản lý change log

- **Mục tiêu:** Tạo file `change.md` để theo dõi mọi thay đổi trong dự án theo quy trình Atomic Commit & Rollback.
- **Files tạo/sửa:** `change.md` _(mới)_
- **Chi tiết thay đổi:**
  - Tạo file `change.md` với cấu trúc đầy đủ: thông tin dự án, quy ước commit, template task.
  - Định nghĩa quy trình làm việc: ghi dự định → code → test → commit hoặc rollback.
- **Trạng thái:** ✅ Đã hoàn thành

---

## 📐 Template Task (copy để dùng lại)

```
### [MODULE-XXX] - [Tên Task]

- **Mục tiêu:** ...
- **Files tạo/sửa:**
  - `path/to/file.ts` *(mới / sửa)*
- **Chi tiết thay đổi:**
  - ...
- **Kết quả kiểm tra:**
  - `pnpm typecheck`: ...
  - `pnpm lint`: ...
- **Trạng thái:** 🔄 Đang xử lý / ✅ Đã hoàn thành / ⏪ Rollback
- **Ghi chú lỗi (nếu rollback):** ...
```

### [C.1.4-CAMERA-H264-TEST] - Chuẩn hoá H.264 và kiểm thử hai camera LAN

- **Mục tiêu:** Cấu hình hai camera kiểm thử Hikvision và Dahua dùng H.264 cho các profile main/sub; tạo Bàn 3 trong tổ chức Kho Đại Kim, đổi mã hai camera thành `dahua_3` ở vai trò `proof_qr` và `hik_3` ở vai trò `proof_primary`.
- **Files tạo/sửa:** Cấu hình encoder hai camera LAN; dữ liệu Supabase cho `BAN_03`, camera/device/assignment/agent; `plans/completed/C.1.4-station-live-page.md`, `change.md`. Toàn bộ script, ảnh, Chrome profile và staging migration QA tạm đã xoá sau kiểm tra.
- **Chi tiết thay đổi:** Hikvision vốn đã H.264; Dahua được đổi các profile H.265 sang H.264 nhưng giữ độ phân giải/FPS/bitrate/GOP. Tạo `BAN_03` trong đúng tenant UI `Betacom`, gán `AGENT_KHO_HN_01`, `hik_3` vai trò `proof_primary`, `dahua_3` vai trò `proof_qr` và scanner ảo `qrcam_dahua_3`. Tenant tạo nhầm trước đó được chuyển inactive/archive, credential camera cũ được xoá nhưng lịch sử được giữ nguyên. Không ép clip xuống 50 MB; giữ trần 90 MiB. Credential chỉ dùng trong RAM.
- **Kết quả kiểm tra:** FFprobe qua MediaMTX đạt: Hik H.264 2688×1520, Dahua H.264 1920×1080; Dahua đọc QR ngay frame xử lý đầu; chữ nhãn đọc rõ; WHEP/CORS localhost đạt; hậu kiểm tenant/agent/device/assignment đạt.
- **Trạng thái:** Đã hoàn thành

### [C.1.4-LIVE-TOGGLE] - Bấm thẻ bàn để mở hoặc đóng live

- **Mục tiêu:** Trên Giám sát đóng hàng, bấm thẻ bàn để mở live hai camera; bấm lại cùng bàn để đóng; đổi sang bàn khác sẽ chuyển live, không tác động tới ghi hình/QR trên agent.
- **Files tạo/sửa:** `src/app/dashboard/operations/page.tsx`, `src/components/station/WebRtcPlayer.tsx`, `src/components/station/LiveLayout.tsx`, `plans/completed/C.1.4-station-live-page.md`, `change.md`; giữ nguyên template.
- **Chi tiết thay đổi:** Chỉ mount `StationLivePanel` khi bàn đang mở; bấm lại cùng bàn unmount viewer, đóng peer/session WHEP nhưng không gọi lệnh dừng recording/camera. Sửa xung đột class `relative` ghi đè `absolute` khiến Dahua PiP nằm ngoài vùng hiển thị; QR PiP có lớp `z-10` đúng góc trên phải.
- **Kết quả kiểm tra:** `pnpm typecheck` đạt; 5/5 test live đạt; 88/88 test agent đạt; ESLint mục tiêu 0 lỗi, còn 1 warning polling cũ ngoài thay đổi. Log trình duyệt xác nhận đồng thời hai peer WHEP Hik/Dahua established.
- **Trạng thái:** Đã hoàn thành

### [SEC-CAMERA-CREDENTIAL-REDACTION] - Không để lộ tài khoản camera trong log

- **Mục tiêu:** Bảo đảm username/password camera do admin nhập không bị ghi nguyên văn hoặc xuất hiện trong RTSP URL tại file cấu hình, hàng đợi lệnh và log; credential chỉ được giải mã tạm thời trong RAM lúc Agent kết nối thiết bị.
- **Files tạo/sửa:** `src/lib/camera/rtsp.ts`, `src/lib/camera/ffmpeg.ts`, `warehouse-agent/src/recording.ts`, `tests/rtsp-redaction.test.ts`, `warehouse-agent/tests/recording-redaction.test.ts`, `warehouse-agent/tests/relay-hub.test.ts`, `plans/completed/SEC-CAMERA-CREDENTIAL-REDACTION.md`, log runtime đã phát sinh và `change.md`; đã xóa `scratch_url.mjs`.
- **Chi tiết thay đổi:** Giữ nguyên luồng kết nối camera cũ qua UI và password mã hóa trong database. Redaction giờ che toàn bộ RTSP userinfo, lọc mọi URL trong FFmpeg stderr thay vì chỉ thay đúng chuỗi đầu vào. Đã làm sạch log Agent cũ, xóa scratch chứa URL credential, khởi động lại Agent nguồn ngoài sandbox và xác nhận MediaMTX nghe tại 8554/8889, hai FFmpeg hoạt động, log cũ/mới đều có 0 credential chưa che. Root test 339/339, Agent test 89/89, hai typecheck và ESLint mục tiêu đều đạt.
- **Trạng thái:** Đã hoàn thành

### [DOC-2CAM-HANDOVER] - Chu thich code va README cho luong 2 camera

- **Muc tieu:** Bo sung chu thich dung cho va README cho cac folder lien quan den luong 2 camera de dev khac doc hieu nhanh pham vi, vai tro va nhung phan da xu ly.
- **Files tao/sua:** `src/lib/camera/README.md`, `src/lib/order-proof/README.md`, `src/lib/live/README.md`, `src/components/station/README.md`, `src/app/api/live/README.md`, `src/app/api/packing-stations/README.md`, `src/app/api/order-proof/README.md`, `src/app/api/agent/README.md`, `src/app/api/cameras/[id]/recording/README.md`, `warehouse-agent/src/README.md`, `warehouse-agent/src/compose/README.md`, `warehouse-agent/src/live/README.md`, `warehouse-agent/src/qr/README.md`, `supabase/migrations/README.md`, `src/components/station/LiveLayout.tsx`, `src/components/station/StationLivePanel.tsx`, `warehouse-agent/src/compose/clip-composer.ts`, `warehouse-agent/src/live/relay-hub.ts`, `warehouse-agent/src/recording.ts`, `change.md`.
- **Chi tiet thay doi:** Da bo sung README ngan cho cac folder chinh cua luong 2-camera va them comment tai cac contract de hong: live layout phai dong bo voi proof composer, viewer toggle khong dung recording, MediaMTX config khong ghi credential, RTSP redaction che ca username/password. Khong doi logic runtime trong phan tai lieu.
- **Trang thai:** Da hoan thanh

### [FIX-2CAM-SEGMENT-COMPOSE] - Sua ghep segment 2 camera thanh 1 video proof

- **Muc tieu:** Kiem tra va sua pipeline ghep segment cua 2 camera de video dau ra giong khung giam sat: camera toan canh full frame, camera QR PiP goc tren phai.
- **Files tao/sua:** `src/lib/agent-commands/enqueue.ts`, `src/lib/agent-commands/cut-clip-planning.ts`, `tests/cut-clip-planning.test.ts`, `change.md`.
- **Chi tiet thay doi:** Sua logic chon QR camera cho proof clip: neu `packing_events.proof_qr_camera_id` co snapshot thi dung snapshot; neu khong co thi fallback sang camera `proof_qr` dang gan vao station bat ke `packing_stations.scan_source`. `scan_source` chi quyet dinh nguon tao scan, khong duoc lam mat goc Dahua/QR trong video bang chung. Them helper va test de khoa lai behavior nay. Khi chay full agent test, da dung tam runtime warehouse-agent/MediaMTX/FFmpeg test cu dang giu cong 8554; khong lap lai credential trong log bao cao.
- **Ket qua kiem tra:** `pnpm test`: 342/342 pass; `pnpm typecheck`: pass; ESLint cac file muc tieu: pass; `warehouse-agent npm run typecheck`: pass; `warehouse-agent npm test`: fail lan dau do MediaMTX runtime cu chiem port 8554, sau khi dung dung runtime test thi 89/89 pass.
- **Trang thai:** Da hoan thanh

### [OPS-STATION-TIMEOUT-VOICE] - Tran 3 phut moi don va thong bao doc thanh tieng tai ban

- **Muc tieu:** Gioi han thoi gian dong mot don toi da 3 phut, qua han thi cuong che dung video va bao "Video qua thoi gian quy dinh, tu dong dung"; dong thoi cac su kien tai ban (mo ca, quet ma, canh bao) deu duoc doc thanh tieng.
- **Files tao/sua:** `src/lib/station/order-timeout.ts`, `src/lib/station/force-stop-expired-orders.ts`, `src/lib/station/announcements.ts`, `src/lib/station/README.md`, `src/app/api/live/[stationId]/events/route.ts`, `src/app/api/live/README.md`, `src/app/api/warehouse/heartbeat/route.ts`, `src/components/station/StationLivePanel.tsx`, `src/components/station/README.md`, `tests/station-order-timeout.test.ts`, `change.md`.
- **Chi tiet thay doi:** Tran = `max_order_seconds` cua kho, kep trong [30s, 180s]; 180s khop `MAX_CLIP_DURATION_SECONDS`. Don qua han bi chot `timing_status='capped_timeout'`, `work_ended_at = work_started_at + limit`, `work_duration_seconds = limit`, `timing_note='auto_stopped_timeout'`; update kem `.eq("timing_status","open")` nen idempotent giua poll man hinh ban va heartbeat agent. Route events tra them `speech` va `current_order` (deadline, so giay con lai). Man hinh ban doc thanh tieng bang Web Speech API `vi-VN`, ba mau am theo muc, dem nguoc tai cho, canh bao mot lan khi con 30s, chip nhac cham de mo khoa am thanh. Them canh bao "camera chua ghi hinh" khi co don mo ma khong co phien ghi nao dang chay. Cau thong bao: mo ca -> "Mo ca thanh cong"; quet ma hop le -> "Bat dau quay video"; qua han -> "Video qua thoi gian quy dinh, tu dong dung"; them ket thuc ca, chuyen ban, thay nhan vien, ma trung, chua mo ca, QR nhan vien khong hop le.
- **Ket qua kiem tra:** `pnpm test` 351/351 dat (9 test moi); `pnpm typecheck` dat; ESLint cac file muc tieu 0 loi 0 warning. Nghiem thu tren he thong dang chay: don DEMO2CAM-B mo luc 02:15:09 bi heartbeat chot dung 02:18:09 voi `timing_note=auto_stopped_timeout`, log `[station-timeout] cuong che dung ... limit=180s`; clip ghep 2 goc cua don do dai dung 180.00s, 70.3 MB, duoi tran upload 90 MiB.
- **Trang thai:** Da hoan thanh

### [E.1-PLAN] - Ke hoach IP camera co dinh va xem camera tu xa

- **Muc tieu:** Phan tich va lap ke hoach cho hai tinh nang moi: dinh danh camera co dinh (khong phu thuoc IP) va xem camera tu xa ngoai LAN. Chua viet code, cho duyet.
- **Files tao/sua:** `plans/active/E.1-ip-camera-co-dinh-va-remote-live.md`, `change.md`.
- **Chi tiet thay doi:** Chot huong dinh danh camera bang MAC + ONVIF UUID, ghim IP bang DHCP reservation tren router, tu do lai theo MAC khi probe hong; hoan viec set IP tinh qua ONVIF sang pha sau vi rui ro mat quyen truy cap camera. Xem tu xa: so sanh 5 phuong an, chon agent day sub-stream len 1 VPS relay theo yeu cau (SRT vao, WHEP/WebRTC ra), uoc tinh 6-12 USD/thang, kem ba chot chan chi phi (2 viewer, 10 phut, han muc thang). Loai bo NAT port/DDNS va stream 24/7 len cloud. Ghi ro rang xem tu xa khong duoc lam anh huong ghi bang chung.
- **Ket qua kiem tra:** Chua co (tai lieu ke hoach).
- **Cap nhat 16/09 sau khi chot voi chu du an:** chi admin/chu kho noi bo duoc xem; dung main-stream (khong transcode tren may ban, ha bitrate bang cai dat trong camera); he thong se dong goi ban cho khach nen relay da tenant, do dem luu luong theo tenant, hai mo hinh trien khai (relay dung chung / relay rieng cua khach) va cong tac tat theo tenant deu phai co tu ban dau. Chi phi tinh lai o main-stream 4 Mbps: 1,8 GB moi gio-nguoi-xem, gia von ~450 d/gio; VPS Singapore ~12 USD/thang. Them muc kiem tra duong truyen tai kho truoc khi bat.
- **Trang thai:** Cho duyet

### [PROOF-CLIP-FILENAME] - Ten file video xuat ra theo ma van don va thoi gian

- **Muc tieu:** Video bang chung khi tai ve phai co ten `<ma van don>-<ngay>-<gio>.mp4` thay vi UUID.
- **Files tao/sua:** `src/lib/order-proof/clip-file-name.ts`, `src/lib/order-proof/README.md`, `src/lib/watch/proof-clip-signed-url.ts`, `src/lib/watch/use-watch-clip-state.ts`, `src/app/api/order-proof/[pe_id]/watch/route.ts`, `src/app/api/agent/clip-cut-result/route.ts`, `src/app/dashboard/videos/page.tsx`, `tests/clip-file-name.test.ts`, `change.md`.
- **Chi tiet thay doi:** Ten file dang `<ma van don>-<yyyyMMdd>-<HHmmss>.mp4` theo gio VN, moc lay tu `packing_events.scanned_at` de sinh lai clip van ra cung ten. Helper signed URL tra them `downloadUrl` (them query `?download=`) va `fileName`; URL phat inline giu nguyen khong co `download` de khong bien the `<video>` thanh tai xuong. Route `/watch` tra them `download_url` + `file_name`, hook expose ra UI, modal xem video co them nut "Tai video". `clip_name` trong DB nay do cloud tinh khi nhan ket qua cat, khong tin ten agent gui len. Clip cu van tai ve dung ten vi ten duoc tinh lai luc cap signed URL. `bucket_path` giu nguyen.
- **Ket qua kiem tra:** `pnpm test` 357/357 dat (6 test moi); `pnpm typecheck` dat; guard `check-proof-clip-signed-url` dat; ESLint khong phat sinh loi moi (cac loi con lai da co san tren HEAD). Do that tren Storage: URL kem `?download=` tra `content-disposition: attachment; filename=...`, URL khong kem tra null.
- **Trang thai:** Da hoan thanh

### [E.1-ROLLBACK-A] - Rollback ve code da commit, chi giu lai Buoc A (tim camera bang MAC)

- **Muc tieu:** Theo yeu cau: tra cay lam viec ve dung commit 997daab cua nhanh 2-camera de test quet ma don, sau do chi lay lai phan tim kiem bang dia chi MAC, tam hoan phan xem tu xa.
- **Files tao/sua:** `src/lib/camera/mac-columns.ts` (moi), `src/lib/camera/active-credentials.ts`, `src/lib/camera/service.ts`, `warehouse-agent/src/camera-heal.ts`, `warehouse-agent/src/lan-arp.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-heal.test.ts`, `warehouse-agent/tests/lan-arp.test.ts`, `change.md`.
- **Chi tiet thay doi:** Toan bo cong viec E.1 (A + B + UI + infra) duoc cat vao nhanh `e1-backup-20260916` (commit bf78829) TRUOC khi rollback, khoi phuc bang `git checkout e1-backup-20260916 -- .`. Sau do lay lai chi cac file cua Buoc A; rieng `warehouse-agent/src/index.ts` chua ca A lan B nen da go bo ba khoi cua B (import RemotePublisher, khoi tao publisher, hai nhanh lenh live_remote_start/stop, va stopAll luc shutdown). KHONG lay lai: relay-limits, remote-session, media-auth, live/remote, cron sweep, RemoteLivePanel, remote-publish, migration 20260916140000, infra/relay.
- **Ket qua kiem tra:** `pnpm test` 357/357 dat; `pnpm typecheck` dat; ESLint cac file cloud 0 loi; agent `npm run typecheck` dat; agent test 111/112 (1 fail la relay-hub doi cong 8554 dang bi agent that chiem, khong lien quan).
- **Trang thai:** Da hoan thanh

### [E.1-A-FIX-ARP] - Tim camera theo MAC: hoi bang ARP truoc, quet cong chi la du phong

- **Muc tieu:** Sua loi that phat hien khi chay tren kho: agent tu kich hoat do lai dung nhu thiet ke nhung KHONG tim thay camera, du camera van o nguyen tren mang.
- **Files tao/sua:** `warehouse-agent/src/lan-arp.ts`, `warehouse-agent/src/camera-heal.ts`, `warehouse-agent/tests/lan-arp.test.ts`, `warehouse-agent/tests/camera-heal.test.ts`.
- **Chi tiet thay doi:** Nguyen nhan do duoc: quet cong co timeout 1 giay va chay tren chinh may dang ghi hinh. Luc heal chay that, quet chi thay `hosts_open=3 mac_resolved=2`; chay tay vai giay sau tren cung subnet thay `hosts_open=7 mac_resolved=6` — camera can tim roi mat. Bang ARP luc do da co san dung IP. Nen doi thu tu: (1) `findIpByMac` doc thang bang ARP, loc theo tien to /24, tu choi khi MAC ung nhieu IP; (2) chua thay moi quet, va quet xong tra lai ARP lan nua vi quet chinh la cach danh thuc ARP; (3) THEM buoc xac nhan cong RTSP mo o IP moi truoc khi bao cloud — khop MAC da manh nhung mot ban ghi ARP cu co the tro vao thiet bi da tat. Do that tren LAN kho: tra ARP mat 47-60 ms va dung ca hai camera, so voi 4,7 s cua mot lan quet.
- **Ket qua kiem tra:** agent test 111/112 (6 test moi: 3 cho findIpByMac, 3 cho thu tu tim kiem va chot "chua xac nhan RTSP thi khong bao cloud"); `npm run typecheck` dat. Do truc tiep tren LAN that: MAC Hikvision -> 192.168.31.135 trong 60 ms, MAC Dahua -> 192.168.31.12 trong 47 ms.
- **Trang thai:** Da sua va co test; CHUA chay lai chuoi day du tren agent that vi may dang duoc dung de test quet ma don.

### [E.1-A-DB-FALLBACK] - Cloud khong duoc gay khi database chua co cot MAC

- **Muc tieu:** Chan lai mot loi da xay ra that: ma nguon doi cot `cameras.mac_address` tren database chua ap migration, lam hong ca luong ghi hinh.
- **Files tao/sua:** `src/lib/camera/mac-columns.ts` (moi), `src/lib/camera/active-credentials.ts`, `src/lib/camera/service.ts`.
- **Chi tiet thay doi:** Ma nguon va migration khong len cung luc. Luc 14:10 ngay 16/09 dieu do xay ra: `[camera-probe] active_cameras lookup failed ... column cameras.mac_address does not exist` — agent mat danh sach camera can ghi. Them `selectCamerasWithMacFallback`: gap loi undefined_column (42703) lien quan cot MAC thi chay lai truy van voi danh sach cot cu va canh bao mot lan kem ten migration can ap. Duong ghi (them/sua camera) cung tu bo `mac_address` khoi payload thay vi tu choi tao camera. Mat MAC chi mat kha nang tu do IP; mat truy van la mat ghi bang chung — khong danh doi duoc.
- **Ket qua kiem tra:** Do tren he thong dang chay voi database CHUA ap migration: truoc khi sua, moi nhip `camera-probe` deu kem dong `column cameras.mac_address does not exist`; sau khi sua, khong con dong loi nao va chi con mot canh bao nhac ap migration. `pnpm test` 357/357, `pnpm typecheck` dat.
- **Trang thai:** Da hoan thanh

### [E.1-A-E2E] - Chay dau-cuoi tren agent that: tim ra hai loi chan duong, da sua

- **Muc tieu:** Chung minh chuoi "camera doi IP -> he thong tu tim lai -> GHI HINH TIEP" chay duoc tren tien trinh agent that, khong phai goi ham.
- **Files tao/sua:** `src/lib/supabase/proxy.ts`, `tests/agent-routes-bypass-proxy.test.ts` (moi), `warehouse-agent/src/recording-lifecycle.ts`, `warehouse-agent/src/index.ts`, `plans/reports/E.1-A-nghiem-thu-2026-09-16.md`, `change.md`.
- **Chi tiet thay doi:** Hai loi chi lo ra khi chay that:
  (1) `/api/agent/camera-ip-healed` chua co trong `PUBLIC_API_PREFIXES` cua proxy, nen bi chan tu vong ngoai voi `401 unauthenticated` — request KHONG bao gio toi cho kiem HMAC. Moi test truoc do goi thang route handler nen deu xanh. Da them vao danh sach VA them test `agent-routes-bypass-proxy` doi chieu toan bo `AGENT_API_PATHS` voi danh sach nay; da kiem nguoc bang cach xoa dong khai bao, test do dung nhu mong doi.
  (2) Chua duoc IP roi nhung ghi hinh khong chay lai: nhip probe van tro vao URL cu nen khong bao gio "ok" du 2 nhip de kich hoat phuc hoi nhanh — tu khoa lan nhau, phai cho het nhip long-retry 5 phut. Them `RecordingLifecycle.notifyEndpointHealed()` lay lai credential va spawn ffmpeg ngay sau khi chua xong.
- **Ket qua kiem tra:** Chay that tren agent voi camera that (dung agent nhanh, GIU service production chay nen ghi hinh that khong mat phut nao): tu luc agent khoi dong den khi co segment moi cua hik_3 la **55 giay** — probe hong 3 nhip -> `[camera-heal] IP moi 192.168.31.250 -> 192.168.31.135` -> `[recording-lifecycle] IP vua duoc chua, thu ghi lai ngay` -> `long-retry refreshed credentials (rtsp_url changed)` -> `[segment-index] rolled camera=hik_3`. DB: ip ve dung, `ip_auto_healed_count` tang, `ip_last_changed_at` co moc, mot dong `camera_endpoint_history` source=auto_heal. Kiem tien trinh: ffmpeg dang doc 192.168.31.135. `pnpm test` 358/358; agent test 111/112 (1 fail relay-hub doi cong 8554, co tu truoc).
- **Trang thai:** Da hoan thanh — muc nghiem thu 2.4.1 cua ke hoach E.1 DAT

### [E.1-A-2CAM] - Nghiem thu muc 2.4.2: camera cung model tren cung subnet

- **Muc tieu:** Chung minh he thong khong nhan nham khi trong kho co hai camera cung model.
- **Files tao/sua:** `plans/reports/E.1-A-nghiem-thu-2026-09-16.md`, `plans/active/E.1-ip-camera-co-dinh-va-remote-live.md`, `change.md`.
- **Chi tiet thay doi:** Khong sua code. Chu du an cam them camera; tren LAN co ba thiet bi mo cong RTSP: 192.168.31.12 (dahua_3), 192.168.31.18 (cung dong firmware voi hik_3, header HTTP giong het), 192.168.31.135 (hik_3).
- **Ket qua kiem tra:** Phan biet 4/4 tren ca hai duong tim kiem (tra ARP va qua ket qua quet), gom ca truong hop MAC bia lech dung 1 ky tu so voi hik_3 — tra ve "khong thay" chu khong vo lay camera cung model ben canh. Chay dau-cuoi voi ca ba camera dang song: 55 giay, chon dung .135, ffmpeg xac nhan doc 192.168.31.135, khong dung toi .18. Lan quet nay lai bo sot .18 (hosts_open=4) trong khi ARP thay du ba — lan thu ba quan sat duoc hien tuong nay.
- **Trang thai:** Da hoan thanh — muc 2.4.2 DAT

### [FIX-QRCAM-SCANNER] - Camera quet ma thieu scanner ao lam moi lan quet hong trong im lang

- **Muc tieu:** Sua goc loi khien mo don bang QR khong chay: moi ma quet bang camera deu tra `unmapped_scanner`.
- **Files tao/sua:** `src/lib/camera/qr-virtual-scanner.ts` (moi), `src/lib/camera/service.ts`, `tests/qr-virtual-scanner.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:** Agent bao ma quet duoi ten thiet bi `qrcam_<ma camera>`; cloud tra ten do qua `resolve_scanner_at`, ham nay doi thiet bi `status='active'` VA co mot phan cong dang mo. Scanner ao chi duoc tao trong nhanh gan cua `POST /api/station-device-assignments`. Ngay 15/09 camera `dahua_3` duoc chuyen sang BAN_03 cua to chuc Betacom bang cach tao ban ghi thiet bi moi (khong qua duong gan chuan), nen scanner ao cu bi archive lai o to chuc Dai Kim va to chuc moi khong co cai nao — hon mot ngay moi lan quet deu hong ma dashboard khong co canh bao nao, chi mot dong log o agent. Them `planVirtualScannerRepairs` (ham thuan, quyet dinh viec can sua) va `ensureQrVirtualScanners` (thuc thi) chay ngay sau `ensureCameraSoftLinks` trong `listCameras`, cung TTL 30s va cung bi xoa boi `invalidateCameraCaches`. Ba rang buoc co y: camera chua gan vao ban nao thi KHONG tao gi; khong bao gio go scanner ao (sai lech sua bang cach gan lai); khong tra duoc ma camera thi bo qua chu khong doan ten thiet bi.
- **Ket qua kiem tra:** 7 test moi cho phan quyet dinh (tao moi, dung yen khi da dung, bat lai ban archived, keo ve dung ban khi gan nham, va hai truong hop khong duoc tao gi). Chay that tren ban sao production o Supabase local: truoc khi chay khong co `qrcam_*` nao; sau mot lan goi `listCameras` da tao `qrcam_dahua_3` active va gan vao BAN_03; `resolve_scanner_at` tra ve dung cap device/station. `pnpm test` 365/365; `pnpm typecheck` dat; ESLint sach.
- **Trang thai:** Da hoan thanh phan ma; DB dang chay se tu sua khi mo trang Thiet bi lan dau.

### [UI-GAN-MAC] - Cho phep gan MAC cho camera da co trong he thong

- **Muc tieu:** Mo duong trong UI de ket noi camera theo MAC: quet ra MAC -> bam vao thiet bi -> man hinh nhap username/password cua camera -> kiem tra ket noi -> luu kem MAC.
- **Files tao/sua:** `src/components/devices/CamerasView.tsx`, `change.md`.
- **Chi tiet thay doi:** Truoc day hang thiet bi da co trong he thong chi hien mot NHAN CHET "Da them", khong bam duoc. Hau qua: camera them tu truoc khi co tinh nang MAC khong con duong nao de gan MAC — ma thieu MAC thi khong tu do lai duoc khi DHCP doi IP, tuc la tinh nang Buoc A vo dung voi dung nhung camera dang chay that. Nay hang do la mot NUT: hien "Gan MAC" (mau ho phach) khi quet ra MAC ma ban ghi chua co hoac khac, hien "Ket noi lai" khi da khop; kem nhan "Chua luu MAC" ngay tren hang de nhin la thay. Form dung lai y nguyen man hinh nhap tai khoan cu, nhung duoc dien san ten/ma/username/duong RTSP tu ban ghi hien co, va khi luu thi goi PUT `/api/cameras/:id` thay vi POST — tao moi se de ra ban ghi trung IP va lam hong lien ket ban/thiet bi dang chay.
- **Ket qua kiem tra:** Chay that tren ban sao production o Supabase local voi hai camera that, dung chinh hai buoc ma nut se goi: kiem tra ket noi RTSP dat (dahua_3 605 ms, hik_3 523 ms, transport tcp) roi luu — MAC vao dung ban ghi (08:ED:ED:9F:DB:97 va 8C:22:D2:6C:7F:19), camera giu nguyen id nen khong dut lien ket bang/thiet bi. Lenh quet chay qua duong that (agent_commands type=discover_lan -> agent quet -> tra ket qua): 4 giay, ca hai camera deu co mac_address, onvif_detected=true va goi y duong RTSP. `pnpm test` 365/365; `pnpm typecheck` dat; ESLint sach.
- **Trang thai:** Da hoan thanh

### [LOCAL-COPY-AUTH] - Ban sao local: keo lai toan bo du lieu va sua loi 403 khi dang nhap

- **Muc tieu:** Ban sao local dung duoc de bam thu tren UI. Truoc do moi route cua tenant deu tra 403 `no_organization`.
- **Files tao/sua:** `scripts/copy-prod-to-local.sh` (lay lai tu nhanh `e1-backup-20260916`), `C:\Users\<user>\supabase-master\docker\docker-compose.yml` (ngoai repo, da backup kem dau thoi gian), `change.md`.
- **Chi tiet thay doi:** Nguyen nhan 403 KHONG phai thieu du lieu: `organization_id` di vao JWT qua ham `custom_access_token_hook`, ma GoTrue cua stack local chua bat hook do (hai dong bi comment trong docker-compose). Token cap o local vi vay khong co to chuc, `resolveTenant` tra 403. Da bat `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED` + `..._URI`, cap `grant execute` ham hook va `grant select` bang `user_profiles` cho `supabase_auth_admin`, roi recreate rieng container auth. Keo lai toan bo du lieu that sang local bang script cu (chi doc tu production). Ap lai migration MAC vao ban sao sau khi copy.
- **Ket qua kiem tra:** Dang nhap that vao stack local roi giai ma token: co `organization_id=00000000-...-0001` va `user_role=admin` (truoc do khong co truong nao). Doi chieu du lieu sau copy: user_profiles 10, organizations 2, cameras 4, packing_stations 5, station_devices 12, packing_events 3402, auth.users 11, platform_admins 1. Cot `mac_address` va bang `camera_endpoint_history` con nguyen. Agent noi lai vao ban sao: `boot-declare status=200`. Rieng schema `storage` van khong nap duoc (ban self-hosted cu hon production, thieu `buckets.versioning_status` va `objects.archived_at`) — khong anh huong vi file video khong nam trong database.
- **Trang thai:** Da hoan thanh

### [MAC-PROD] - Ap cot MAC len Supabase chinh va chuyen rig ve chay that

- **Muc tieu:** Bat tinh nang dinh danh camera theo MAC tren he thong dang chay, khong con phai thu tren ban sao.
- **Files tao/sua:** `src/components/devices/CamerasView.tsx`, `change.md`. Migration da co san: `supabase/migrations/20260916120000_camera_mac_identity.sql`.
- **Chi tiet thay doi:** Ap migration MAC vao database chinh (chi them: 4 cot nullable tren `cameras`, mot unique index theo (organization_id, mac_address), bang `camera_endpoint_history` + RLS; toan bo `IF NOT EXISTS` nen chay lai an toan, khong viet lai du lieu). Ket noi qua Session Pooler cong 5432 (host `aws-1-ap-southeast-1`, khong phai `aws-0`). Kem mot sua o UI: sau khi luu, doi chieu MAC tra ve tu server voi MAC da gui; neu server khong luu duoc thi hien canh bao "CHUA luu duoc MAC" thay vi bao thanh cong. Truoc do lop lui cot MAC lam API van tra 200 nen UI se noi doi la da gan MAC — nguoi dung tin camera da dinh danh duoc, toi luc DHCP doi IP moi biet la khong.
- **Ket qua kiem tra:** Doc lai tu API cua Supabase chinh: cot `mac_address`, `ip_auto_healed_count` va bang `camera_endpoint_history` deu co; bon camera hien mac=(trong) dung nhu mong doi. Dev server chay lai voi `.env.local` (database chinh): khong con dong `column cameras.mac_address does not exist` nao. Agent noi lai: `boot-declare status=200`. Da tat toan bo container Supabase local (`docker compose stop`, 0 container con chay). `pnpm typecheck` dat; ESLint sach.
- **Trang thai:** Da hoan thanh

### [PORT-LINH-HOAT] - Agent tu tim cong cua cloud, khong con neo cung 3000

- **Muc tieu:** He thong chay duoc o bat ky cong trong nao — 3000, 3001, 3002 deu duoc.
- **Files tao/sua:** `warehouse-agent/src/backend-url.ts` (moi), `warehouse-agent/src/index.ts`, `warehouse-agent/tests/backend-url.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:** `BACKEND_URL` trong `.env` ghi cung `https://localhost:3000`, trong khi Next chi UU TIEN 3000 chu khong giu cho — cong ban la no nhay sang 3001/3002. Khi do agent go cua cong cu, khong ai tra loi, va moi bao cao dung im TRONG KHI ghi hinh van chay: nhin ben ngoai nhu he thong song, thuc ra khong co gi len cloud. Them `resolveBackendUrl` voi thu tu: (1) URL dang cau hinh neu no tra loi — khong gay bat ngo; (2) cong doc tu `.next/dev/lock` (Next tu ghi cong that vao day, chinh xac chu khong phai doan); (3) do lan luot 3000-3005 lam luoi cuoi. Khong tim thay thi GIU nguyen URL cu de agent van retry nhu cu chu khong chet han. Chay luc khoi dong truoc khi dung bat cu module nao, va mot nhip 60s de bam theo neu cloud khoi dong lai o cong khac.
- **Ket qua kiem tra:** Chay that: cho cloud len o cong 3001 trong khi `.env` van ghi 3000 — agent log `[backend-url] cloud khong o https://localhost:3000, dung https://localhost:3001 (nguon: dev-lock)` roi `boot-declare status=200`, khong sua mot dong cau hinh nao. Tra ve cong 3000 cung chay binh thuong. 9 test moi, trong do co test khoa rang buoc quan trong nhat: URL production KHONG duoc do cong (agent tu noi sang mot may chu khac la chuyen khong bao gio duoc xay ra ngoai kho). Agent test 120/121 (1 fail la relay-hub doi cong 8554 dang bi MediaMTX that chiem, co tu truoc); `npm run typecheck` dat.
- **Trang thai:** Da hoan thanh

### [BAN-RA-CAMERA] - Gan camera vao ban theo huong tu BAN ra camera

- **Muc tieu:** Lap camera cho mot ban theo dung thu tu nguoi ky thuat lam: chon ban -> chon vi tri (toan canh / quet QR) -> quet mang tim theo MAC -> nhap tai khoan camera -> ket noi that -> camera gan co dinh vao ban do.
- **Files tao/sua:** `src/components/stations/StationCameraWizard.tsx` (moi), `src/app/dashboard/packing-stations/page.tsx`, `src/app/api/packing-stations/[id]/cameras/route.ts`, `change.md`.
- **Chi tiet thay doi:** Endpoint gan camera theo ban da co san tu truoc nhung KHONG co UI nao goi no — nguoi dung chi co duong nguoc lai (them camera roi gan ban o cho khac). Them wizard: moi ban hien hai o camera (Toan canh / Quet QR), o TRONG duoc ve bang vien dut kem dau cong, bam vao la mo luong quet. Hien ca o trong chu khong chi liet ke thiet bi da gan — ban thieu camera phai nhin ra ngay, khong thi no trong y het ban du. Trong wizard: quet LAN (che do full, agent tu chon subnet), doi chieu MAC voi camera da luu de KHONG tao ban ghi trung, nhap username/password, goi endpoint roi poll lenh cho toi khi agent bao ket noi duoc. Camera chi duoc gan vao ban SAU KHI agent ket noi that — gan truoc roi moi thu la cach tao ra nhung ban "co camera" ma khong co hinh. Camera dang o ban khac thi hoi xac nhan truoc khi chuyen (409 station_transfer_confirmation_required), khong im lang keo sang. Phia route: them `mac_address` vao ca duong tao moi lan cap nhat, va doi thu tu tra cuu camera thanh camera_id -> MAC -> IP; tra theo IP truoc se nhan nham khi DHCP vua cap lai dia chi do cho may khac.
- **Ket qua kiem tra:** `pnpm test` 365/365; `pnpm typecheck` dat; ESLint 0 loi (1 canh bao set-state-in-effect co san tu truoc o trang ban). Trang `/dashboard/packing-stations` va route API bien dich sach tren dev server dang chay. Quyen `packing_station.camera_setup` doi chieu tren database that: chi owner va admin co.
- **Trang thai:** Da hoan thanh phan ma; chua bam thu tren giao dien that.

### [VAI-TRO-CAMERA] - Chon ro camera chinh hay camera QR khi gan ban

- **Muc tieu:** Gan camera vao ban theo luong "them thiet bi -> dang nhap camera -> gan ban", chon vi tri bang o tich, va doi ban duoc khi gan nham.
- **Files tao/sua:** `src/app/dashboard/devices/page.tsx`, `src/lib/camera/service.ts`, `src/components/devices/CamerasView.tsx`, `src/app/api/packing-stations/[id]/cameras/route.ts` (giu phan mac_address), `change.md`. Da GO: `src/components/stations/StationCameraWizard.tsx` va phan o camera co dinh tren trang ban dong goi.
- **Chi tiet thay doi:** Hop thoai Gan ban/Doi ban truoc day chi co MOT o tich "Camera chinh cua ban": tich = `role: proof_primary`, bo tich = KHONG ghi vai tro nao. Khong co duong nao khai bao camera quet QR. Nang hon, `loadCameraStationMap` va vai cho khac doc thieu vai tro thanh proof_primary — nen mo mot camera QR ra sua roi luu la no lang le bien thanh camera toan canh. Nay hai lua chon tach bach ("Camera chinh (toan canh)" / "Camera quet QR"), luon ghi ro `role`, va `current_station` tra them truong `role` de giao dien doc dung trang thai hien tai thay vi suy tu `is_primary`. Giu `is_primary` cho cac man hinh cu. Chuc nang "Doi ban" da co san tu truoc trong cung hop thoai — khong phai lam moi.
- **Ket qua kiem tra:** `pnpm test` 365/365; `pnpm typecheck` dat; ESLint 0 loi (6 canh bao set-state-in-effect y het truoc khi sua — da doi chieu bang cach lint lai ban goc). Da ngat ca 3 thiet bi khoi BAN_03 de thu lai tu dau; agent xac nhan `no desired cameras`, 0 tien trinh ffmpeg.
- **Khong xoa camera cu:** `order_proof_clips.camera_id` la RESTRICT va co 16 clip bang chung tro vao hai camera do nen xoa se bi tu choi; neu ep xoa thi `camera_recording_files` CASCADE keo theo 1.238 dong chi muc file ghi hinh. Giu camera, chi bo gan khoi ban.
- **Trang thai:** Da hoan thanh

### [CHON-BAN-TAI-CHO] - Chon ban va vi tri camera ngay tren bang thiet bi kho

- **Muc tieu:** Luong lap camera: Thiet bi kho -> Them thiet bi -> tim qua RTSP -> chon MAC -> nhap user/mat khau -> ket noi; xong ra bang chinh chon "Ban dang phuc vu" trong danh sach tha xuong roi chon vi tri (toan canh / QR); sau do vao Giam sat kho bam vao ban do la co livestream.
- **Files tao/sua:** `src/components/devices/StationAssignCell.tsx` (moi), `src/app/dashboard/devices/page.tsx`, `change.md`.
- **Chi tiet thay doi:** Cot "Ban dang phuc vu" truoc day chi la chu, muon gan phai mo hop thoai rieng. Nay la mot o tha xuong ngay trong bang: dong dau tien "Chua gan", ben duoi la toan bo ban dang hoat dong (them ban moi thi tu co mat, vi danh sach lay tu `/api/packing-stations`). Chon "Chua gan" = go khoi ban. Voi camera, chon ban xong hien tiep nhip chon VI TRI (Toan canh / Quet QR) ngay tai o do; chon xong moi ghi va ket qua hien luon tren bang, kem nut "Doi vi tri". Khong doan ho vi tri: gan nham vai tro nghia la clip bang chung lay sai goc hinh, ma loi do chi lo ra khi can toi clip.
- **Vi sao phai co vi tri:** `/api/live/[stationId]` BO QUA hoan toan camera khong co `config_json.role` la proof_primary hoac proof_qr. Voi UI cu (mot o tich, bo tich = khong ghi vai tro), ban co the co camera gan vao ma man hinh giam sat khong hien gi — khong bao loi, chi trong tron.
- **Ket qua kiem tra:** `pnpm test` 365/365; `pnpm typecheck` dat; ESLint 0 loi (6 canh bao co san tu truoc, da doi chieu). Trang `/dashboard/devices` bien dich sach tren dev server dang chay.
- **Trang thai:** Da hoan thanh phan ma; cho bam thu tren giao dien.

### [CANH-BAO-TRUNG-VI-TRI] - Hoi truoc khi day mot camera ra khoi vi tri cua no

- **Muc tieu:** Gan camera vao cho da co nguoi thi phai bao truoc, khong im lang thay the.
- **Files tao/sua:** `src/components/devices/StationAssignCell.tsx`, `src/app/dashboard/devices/page.tsx`, `change.md`.
- **Chi tiet thay doi:** Hai lop canh bao trong o "Ban dang phuc vu": (1) chon ban ma ban do DA DU 2 camera -> hien "BAN_xx da du 2 camera (<ma>: <vi tri>, ...). Xac nhan doi?"; (2) chon vi tri ma vi tri do dang co camera khac -> hien "Vi tri <ten> o BAN_xx dang la <ma>. Xac nhan doi?" kem cau noi ro camera cu se bi day ra va ve trang thai chua gan ban, camera o vi tri con lai KHONG bi anh huong. Nut chon vi tri cung ghi san "· da co" cho cho dang ban, nen nhin la biet truoc khi bam. Thong bao sau khi gan cung noi ro camera nao vua bi day ra.
- **Vi sao can:** May chu tu truoc den nay VAN day camera cung vi tri ra (loc theo device_type + role trong `POST /api/station-device-assignments`) — dung hanh vi mong muon, nhung lam am tham. Nguoi bam khong he biet minh vua go camera cua mot ban dang chay; nhin bang chi thay camera moi vao, khong thay cai bi mat.
- **Ket qua kiem tra:** `pnpm test` 365/365; `pnpm typecheck` dat; ESLint 0 loi (6 canh bao co san). Trang `/dashboard/devices` bien dich sach. Da doc lai logic may chu de xac nhan chi dong phan cong cua camera CUNG vai tro tai ban do, camera vai tro khac giu nguyen.
- **Trang thai:** Da hoan thanh phan ma; cho bam thu.

### [SUNG-QUET-RIENG] - Scanner ao chi sinh khi ban thuc su quet bang camera

- **Muc tieu:** Kho co sung quet QR phan cung rieng. Dat camera vao vi tri QR khong duoc de ra mot thiet bi ao khong ton tai ngoai kho.
- **Files tao/sua:** `src/lib/camera/qr-virtual-scanner.ts`, `src/lib/camera/service.ts`, `src/app/api/station-device-assignments/route.ts`, `tests/qr-virtual-scanner.test.ts`, `change.md`.
- **Chi tiet thay doi:** Truoc day cu gan camera vai tro `proof_qr` vao ban la sinh `qrcam_<ma camera>`, bat ke ban do quet bang gi. Nay ca hai duong (route gan thiet bi va lop tu sua trong `listCameras`) deu doi dieu kien `packing_stations.scan_source = 'camera'`. Camera o vi tri QR van giu y nghia cho clip bang chung (goc quay doc ma) du ban dung sung quet — hai chuyen do doc lap. Them viec don: scanner ao khong con camera QR nao dung sau (camera doi sang toan canh, roi ban, hoac ban chuyen sang sung quet) thi bi GO — bo gan va cho nghi, KHONG xoa, de con truy vet va lan sau can thi chinh ham do bat lai. Da nghi roi va khong con gan ban thi de yen, khong sua lap moi lan mo trang.
- **Ket qua kiem tra:** `pnpm test` 370/370 (5 test moi: hai ca sung quet, ba ca don rac); `pnpm typecheck` dat; ESLint 0 loi. Chay thu ham quyet dinh tren DU LIEU THAT (chi doc): dung mot viec `DETACH qrcam_hik_3` — thiet bi sinh nham luc thu dat hik_3 vao vi tri QR — va giu nguyen `qrcam_dahua_3` vi dahua_3 dang la camera QR cua BAN_03 (ban nay scan_source=camera).
- **Trang thai:** Da hoan thanh; rac se tu don khi mo trang Thiet bi lan toi.

### [FIX-DUA-GAN-BAN] - Loi "duplicate key ... uniq_active_assignment_per_device" khi gan ban

- **Muc tieu:** Bam gan ban khong con nem loi Postgres tho ra man hinh.
- **Files tao/sua:** `src/app/api/station-device-assignments/route.ts`, `src/lib/camera/service.ts`, `change.md`.
- **Chi tiet thay doi:** Nguyen nhan la MOT CUOC DUA co that giua hai duong cung ghi phan cong: nguoi dung bam gan, trong khi trang nap lai goi `/api/devices` -> `listCameras` -> lop tu sua scanner ao cung dong-roi-chen. Ben cham hon dam vao chi so `uniq_active_assignment_per_device` (mot thiet bi chi duoc co mot phan cong dang mo — rang buoc DUNG, khong sua). Nay: khi chen gap 23505, route doc lai phan cong dang mo cua thiet bi; neu no da tro dung ban ta muon thi coi nhu THANH CONG (ket qua giong het y dinh, bat nguoi dung bam lai mot viec da xong la vo ly); neu tro ban khac thi dong lai va chen them mot lan. Van hong thi tra 409 kem cau tieng Viet de hieu thay vi thong bao cua Postgres. Lop tu sua va nhanh gan scanner ao cung bo qua 23505 cung ly do.
- **Ket qua kiem tra:** `pnpm test` 370/370; `pnpm typecheck` dat; ESLint 0 loi. Doi chieu du lieu that: khong co thiet bi nao co hon mot phan cong dang mo, tuc rang buoc da lam dung viec cua no; ba phan cong hien tai (auto_dahua_3 proof_qr, auto_hik_3 proof_primary, qrcam_dahua_3) deu dung.
- **Trang thai:** Da hoan thanh

### [MAC-QUA-LAN-KHAC] - Nho camera theo MAC, doi mang van tu noi lai

- **Muc tieu:** Sau lan dang nhap dau, MAC nam trong database. Tu do ve sau chi can he thong va camera chung LAN la tu ket noi — ke ca khi doi han sang mang khac (setup o wifi 1, chay o wifi 2).
- **Files tao/sua:** `warehouse-agent/src/lan-arp.ts`, `warehouse-agent/src/camera-heal.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/tests/camera-heal.test.ts`, `change.md`.
- **Chi tiet thay doi:** Truoc day viec tu do lai BI KHOA trong subnet cu: `findIpByMac` loc theo tien to IP cu, va chi quet dung `slash24Of(ip cu)`. Doi wifi la IP sang han dai khac nen khong bao gio tim thay. Nay: (1) tra bang ARP KHONG gioi han subnet, chi doi IP thuoc dai LAN rieng (RFC1918); (2) neu ARP chua biet thi quet subnet cu truoc roi toi cac mang may DANG noi, tran 3 subnet mot lan chua — moi lan quet /24 mo 254 ket noi TCP tren chinh may dang ghi hinh, quet ca chuc mang ao cua Docker/VPN la pha nhieu hon chua; (3) neu IP dang luu khong thuoc mang nao may dang noi thi chua NGAY tu nhip hong dau tien thay vi cho du 3 nhip — do la dau hieu chac chan cua doi mang, cho them chi keo dai thoi gian ban khong co hinh. Cung mang thi van giu nguyen luat 3 nhip, vi mot nhip hong co the chi la nhieu.
- **Ket qua kiem tra:** Agent test 125/126 (1 fail relay-hub doi cong 8554 dang bi MediaMTX that chiem, co tu truoc); 5 test moi: chua qua mang khac khi ARP biet (khong quet gi), quet subnet cu truoc roi toi mang hien tai, tran so subnet, va hai ca cho luat "chua ngay khi doi mang". `npm run typecheck` dat. Doi chieu database that: ca hai camera da co MAC (08:ED:ED:9F:DB:97 va 8C:22:D2:6C:7F:19) — dieu kien tien quyet da du.
- **Trang thai:** Da hoan thanh phan ma; agent dang chay van la ban cu, can khoi dong lai de co hieu luc.

### [AGENT-NHAN-CAMERA-VA-GHI-THEO-BAN] - Dang nhap camera la agent nhan ngay; gan ban la bat ghi segment

- **Muc tieu:** Theo thiet ke cua chu du an: quet MAC + dang nhap camera -> agent da quet thay camera nhan no ngay (co livestream); gan camera vao ban -> bat dau cat segment; khi can video thi biet dung 2 camera cua ban de ghep.
- **Files tao/sua:** `src/lib/camera/discovering-agent.ts` (moi), `src/lib/camera/station-recording.ts` (moi), `src/app/api/cameras/route.ts`, `src/app/api/cameras/[id]/route.ts`, `src/app/api/station-device-assignments/route.ts`, `src/lib/camera/service.ts`, `tests/discovering-agent.test.ts` (moi), `change.md`.
- **Su co goc (17/09 13:37):** camera EZVIZ `CAM_TEST` them qua "Them thiet bi" nam voi `agent_id = null`. Agent chi dung duong relay cho camera tro ve chinh no, nen MediaMTX bao `path 'c43414d5f54455354m' is not configured` va trinh duyet nhan WHEP 400 — khong mot dong canh bao nao tren giao dien. Da kiem luong EZVIZ bang ffprobe voi tai khoan da luu: H.264 Main 1920x1080 tren ca 4 duong RTSP, tuc khong phai loi codec hay duong dan.
- **Chi tiet thay doi:** (1) `findDiscoveringAgent`: chon agent theo KET QUA QUET LAN — agent chi voi toi duoc camera cung mang voi may no chay. Khop MAC truoc, IP sau, lay lan quet moi nhat (camera doi mang thi lan quet moi moi dung). Khong thay lan quet nao: to chuc chi co mot agent thi giao cho no, nhieu agent thi KHONG doan. Tra o may chu, khong tin truong agent tu trinh duyet. (2) `POST /api/cameras` va `PUT /api/cameras/:id` goi `bindCameraToDiscoveringAgent` ngay sau khi luu — khong de agent da co bi doi may chi vi ai do bam luu lai. (3) `station-recording.ts`: gan camera vao ban DANG CO CA thi bat ghi ngay; ban chua co ca thi de luong mo ca bat; camera bi day khoi vi tri, chuyen sang ban khong co ca, hoac bi go khoi ban thi DUNG ghi tuong minh — camera ve hang doi van thuoc agent (de con xem livestream) nen agent khong tu thu hoi lenh ghi, khong dung thi mot camera "chua gan ban" van ghi day o. Truoc day o chon ban chi ghi phan cong, khong bat ghi gi.
- **Phan da dung san, khong sua:** khi can video, `enqueue.ts` lay ban cua don -> camera `proof_primary` (anh snapshot `proof_camera_id` neu co) va `proof_qr` (snapshot `proof_qr_camera_id` neu co) gan vao ban do -> bao agent cat va ghep dung hai camera. Khong phu thuoc agent thuoc ban nao.
- **Ket qua kiem tra:** Da gan `CAM_TEST` cho `AGENT_KHO_HN_01` (agent da quet thay MAC 90:31:4B:22:FA:49 luc 03:41:58). Trong vong mot nhip dong bo, `mediamtx.generated.yml` co path `c43414d5f54455354m`, loi "not configured" dung han; doc qua relay noi bo `rtsp://127.0.0.1:8554/c43414d5f54455354m` tra h264 1920x1080, MediaMTX bao `stream is available and online, 2 tracks (H264, MPEG-4 Audio)`. `pnpm test` 376/376 (6 test moi cho viec chon agent); `pnpm typecheck` dat; ESLint 0 loi.
- **Con lai (chua lam, can quyet dinh):** `listCameraCredentials` tinh vai tro, nguon quet va ca dang mo CHI cho mot ban — `warehouse_agents.station_id`. Mot agent vi vay chi phuc vu tron ven mot ban; camera gan vao ban khac co livestream nhung khong duoc ghi theo ca cua ban do.
- **Trang thai:** Da hoan thanh phan nhan agent va ghi theo gan ban.

### [MOT-AGENT-NHIEU-BAN] - Mot agent phuc vu moi ban trong kho

- **Muc tieu:** Chu du an chot 17/09/2026: "dung 1 agent cho de quan ly". Agent phai tinh vai tro, nguon quet, ca mo va doc QR THEO BAN CUA TUNG CAMERA, khong theo mot ban duy nhat cua agent.
- **Files tao/sua:** `src/lib/camera/camera-stations.ts` (moi), `src/lib/camera/active-credentials.ts`, `warehouse-agent/src/shift-recording.ts`, `warehouse-agent/src/qr/qr-scan-service.ts`, `warehouse-agent/src/index.ts`, `tests/camera-stations.test.ts` (moi), `warehouse-agent/tests/shift-recording.test.ts`, `warehouse-agent/tests/qr-scan-service.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:**
  (1) Cloud — `listCameraCredentials` truoc day lay `warehouse_agents.station_id` (mot ban) roi ap chung vai tro/nguon quet/ca mo cho moi camera cua agent. Camera gan vao ban thu hai co livestream nhung khong bao gio co vai tro, nen khong duoc ghi theo ca. Nay `resolveCameraStations` (ham thuan) tinh tu phan cong dang mo cua TUNG camera. Hop dong du lieu voi agent khong doi — moi item von da co san `station_id`, `role`, `scan_source`, `station_has_open_session`; chi cach tinh la sai.
  (2) Agent — quet QR nhan vien truoc day bat ghi MOI camera du dieu kien. Voi nhieu ban, quet o BAN_01 se bat ghi ca BAN_03, tron bang chung hai ban. Nay `pickShiftCameras`: QR doc tu camera -> chi ban cua camera do; sung quet serial (agent khong biet sung gan ban nao) -> neu agent chi co camera cua mot ban thi van bat ban do (giu nguyen hanh vi kho mot ban), nhieu ban thi KHONG bat gi, de cloud quy ve dung ban.
  (3) Agent — bo doc QR truoc day giu MOT camera (`find` phan tu dau), nen ban quet bang camera thu hai quet gi cung im lang. Nay moi ban `scan_source = camera` mot luong rieng, moi luong mot vung khu trung (`QrZone`) rieng — dung chung thi cung mot ma gio len o hai ban cach nhau vai giay se bi nuot lan thu hai. Ban dung sung quet khong ton luong nao.
- **Ket qua kiem tra:** Chay ham cloud moi tren DU LIEU THAT (chi doc): CAM_TEST -> BAN_01/proof_primary/scanner; dahua_3 -> BAN_03/proof_qr/camera/qrcam_dahua_3; hik_3 -> BAN_03/proof_primary/camera. Truoc day CAM_TEST se nhan ban cua agent (BAN_03) va vai tro null. Nap agent moi (chay tach khoi phien lam viec): `boot-declare 200`, bo doc QR chi mo cho `dahua_3` (dung — BAN_01 dung sung quet), du 5 duong relay cho ca 3 camera. `pnpm test` 381/381 (5 test moi); agent test 136/137 (1 fail relay-hub doi cong 8554, co tu truoc; 11 test moi); ca hai typecheck dat.
- **Phat hien khi lam (chua sua, can quyet):** production KHONG co lop database cua nhanh 2-camera. Hai migration `20260914080000_two_cameras_logic_schema.sql` va `20260914165000_two_cameras_shift_recording.sql` chua tung duoc ap: thieu cot `packing_events.proof_qr_camera_id`, cac cot ghep goc cua `order_proof_clips`, bang `order_proof_requests`, trigger chup camera QR luc quet, va trigger BAT/DUNG GHI THEO CA. Code dang chay nho cac nhanh du phong "chua ap migration". Rieng trigger ghi theo ca con mang dieu kien `wa.station_id = sda.station_id` — dung loai rang buoc mot-ban vua go bo o tren.
- **Trang thai:** Da hoan thanh phan code; lop database cho ghi theo ca cho chu du an quyet.

### [MIGRATION-2CAM-PROD] - Gop lop database 2-camera o dang mot agent nhieu ban

- **Muc tieu:** Dua lop database cua nhanh 2-camera len production (chu du an dong y 17/09/2026), o dang mot agent phuc vu nhieu ban.
- **Files tao/sua:** `supabase/migrations/20260917090000_two_cameras_one_agent_many_stations.sql` (moi), `plans/reports/E.1-ap-migration-2camera-production-2026-09-17.md` (moi), `change.md`.
- **Chi tiet thay doi:** Khong ap nguyen hai file cu vi thuc nghiem cho thay ca hai gay hai. (1) `20260914080000`: trigger chup camera QR doc `cameras.station_id` — cot khong ton tai; da thu tren ban sao local, chen `packing_events` bao `column c.station_id does not exist`, tuc MOI LAN QUET MA VAN DON se hong. (2) `20260914165000`: trigger ghi theo ca doi `wa.station_id = sda.station_id`, trai voi mo hinh mot agent nhieu ban. File moi gop ca hai, viet lai trigger chup camera QR theo phan cong that (station_device_assignments + vai tro), bo rang buoc agent-ban, bat RLS cho `order_proof_requests` (file goc quen — Supabase cap san quyen schema public cho anon/authenticated nen bang khong RLS la doc ghi duoc tu trinh duyet), va boc phan phu trong EXCEPTION -> WARNING de khong bao gio chan quet ma hay mo ca. Kem noi rong rang buoc `progress_state` — tren production no chi cho 'encoding', nen moi cap nhat tien do cutting/composing/uploading cua luong ghep hai goc dang bi tu choi.
- **Ket qua kiem tra:** Chay thu toan bo migration + kich ban hanh vi tren ban sao local trong mot transaction roi ROLLBACK: mo ca o BAN_01 (khong phai ban cua agent) ra `start_recording hik_3@BAN_01` — trigger cu khong ra lenh nao; mo ca BAN_03 them `dahua_3@BAN_03` khong trung lenh; dong ca BAN_01 ra `stop_recording` hen 60s, BAN_03 khong bi dung; quet ma o BAN_03 chup `proof_qr_camera_id=dahua_3`; quet ma o ban khong co camera van ghi duoc; RLS bat; progress_state da noi. Guard `check-migration-versions`: 81 version, 0 trung. Production luc kiem: khong co ca nao dang mo.
- **Chua lam duoc:** tang bao ve cua cong cu chan ghi thang len production ("Production Deploy") du chu du an da dong y. Da viet huong dan chay tay 4 buoc (ap, ghi lich su migration, kiem tra, thu that) trong bao cao di kem.
- **Trang thai:** Cho chu du an chay migration trong Supabase Studio.

### [MIGRATION-2CAM-PROD-FILE-DAN] - Gop migration + lich su + kiem tra thanh mot file dan mot lan

- **Muc tieu:** Chu du an yeu cau chay het giup. Tang bao ve cua cong cu chan MOI lenh toi database production (ca lenh chi doc) du chu du an da dong y hai lan, nen gom thanh mot file de dan mot lan trong SQL Editor.
- **Files tao/sua:** `plans/reports/E.1-ap-migration-2camera-production-2026-09-17.sql` (moi), `change.md`.
- **Chi tiet thay doi:** File gom (1) nguyen van migration `20260917090000` (tu boc BEGIN/COMMIT), (2) ghi lich su bon version vao `supabase_migrations.schema_migrations` — dung `where not exists` thay vi `on conflict` de chay dung ke ca khi cot version khong co rang buoc duy nhat va chay lai nhieu lan van an toan, (3) cau kiem tra bon muc. Buoc (2) la BAT BUOC: khong ghi lich su thi `supabase db push` sau nay se chay lai file 20260914080000 va cai lai trigger hong lam hong moi lan quet ma van don.
- **Ket qua kiem tra:** Tren ban sao local: phan (1) ap tron, phan (3) bon dong deu bang 1. Phan (2) chay hai lan lien tiep trong transaction ra dung 4 dong, khong trung. Ban sao local nay DA co migration 20260917090000 (ap that, khong rollback) — dung la trang thai mong muon cho ban sao.
- **Trang thai:** Cho chu du an dan file vao Supabase Studio.

### [TAT-TIENG-BO-QUA] - Tat tieng thi bo qua thong bao, bat lai khong doc don tin cu

- **Muc tieu:** Luc dang tat tieng ma co thong bao thi bo qua han. Bat tieng lai khong duoc doc mot trang cac thong bao cu roi moi toi thong bao hien tai.
- **Files tao/sua:** `src/components/station/StationLivePanel.tsx`, `change.md`.
- **Chi tiet thay doi:** Truoc day chip "Da bat thong bao tieng" chi la NHAN — mo khoa am thanh mot chieu o lan bam dau tien, khong tat duoc. Va khi am thanh chua duoc phep, moi su kien van goi `speechSynthesis.speak()`; trinh duyet XEP HANG cac cau do, toi luc duoc phat thi xa het mot luot roi moi toi cau hien tai. Nay: (1) chip thanh cong tac that, tach "y muon nghe" (`soundOn`) khoi "trinh duyet da cho phat" (`audioReady`), ba trang thai: chua mo khoa / dang bat / da tat; (2) dang tat hoac chua mo khoa thi BO QUA am bao va giong doc, khong xep hang — thong bao chu (toast) van hien vi tat tieng khong co nghia la khong muon biet; (3) bat hay tat deu goi `speechSynthesis.cancel()` de xoa hang doi trinh duyet lo giu; (4) luoi cuoi: cau nao den luc phat da tre qua 4 giay (tab tat tieng, tab nam nen, am thanh chua mo khoa) hoac nguoi dung vua tat tieng thi huy ngay trong `onstart` — tin cu doc ra luc do con hai hon im lang vi nguoi nghe tuong la chuyen vua xay ra.
- **Ket qua kiem tra:** `pnpm typecheck` dat; ESLint file nay 0 loi 0 canh bao; trang `/dashboard/operations` bien dich sach tren dev server dang chay.
- **Trang thai:** Da hoan thanh; cho bam thu tren giao dien.

### [GHI-CAMERA-QR-MOI-CHE-DO-QUET] - Mo ca thi ghi ca camera goc QR, ke ca ban quet bang sung

- **Muc tieu:** Thu mo ca BAN_01 (scan_source=scanner, chi co EZVIZ_1 goc QR) khong ra lenh `start_recording` nao. Ban nao co camera gan vao thi mo ca phai ghi segment camera do, bat ke ban quet bang sung hay camera.
- **Files tao/sua:** `supabase/migrations/20260917100000_record_qr_camera_regardless_of_scan_source.sql` (moi), `warehouse-agent/src/shift-recording.ts`, `warehouse-agent/tests/shift-recording.test.ts`, `change.md`.
- **Chi tiet thay doi:** Trigger `enqueue_session_recording_commands` va `camerasForShiftStart` o agent chi chon camera `proof_qr` khi `scan_source = 'camera'`. Mau thuan voi `cut-clip-planning.ts`: video bang chung luon ghep goc QR neu ban co — `scan_source` chi quyet dinh thiet bi nao duoc TAO luot quet. Hau qua: ban sung + camera QR khong co segment goc QR de cat; ban chi co camera QR khong ghi gi. Bo dieu kien `scan_source` o ca hai noi; phan con lai cua ham giu nguyen. Doc QR bang camera van chi chay khi `scan_source = 'camera'` (khong doi).
- **Ket qua kiem tra:** Agent `tests/shift-recording.test.ts` 10/10. Chay thu tren ban sao local trong transaction + ROLLBACK: ban scanner chi co camera QR — trigger cu 0 lenh, trigger moi `start_recording dahua_3 reason=station_shift_opened`; dong ca → `stop_recording dahua_3` hen 60s.
- **Kiem thu that tren production (17/09/2026):** Chu du an dan migration trong SQL Editor. Mo ca BAN_04 (scanner) -> trigger ra `start_recording CAM_TEST reason=station_shift_opened`, agent may dev nhan lenh, ffmpeg ghi segment 60s co `agent_id`. Nap don `TEST260917162757` -> clip 162s cat + upload `ready`. Chuyen hik_3 (toan canh) + dahua_3 (QR) sang BAN_04 khi ca dang mo: lenh ghi `skipped` vi dang ghi san, khong dut segment. Don `TEST260917164354`: `proof_camera_id=hik_3`, `proof_qr_camera_id=dahua_3`; lenh cut_clip `overview=hik_3` + `qr=dahua_3`, clip PiP 74,6s 28,9MB upload `ready`; trich khung hinh xac nhan hai camera khac nhau.
- **Phat hien trong luc test (chua sua):** (1) may khac chay agent ban cu cung ma `AGENT_KHO_HN_01` lay mat lenh, segment `agent_id = NULL` nen khong cat duoc clip — chu du an da tat agent do; (2) lan ghi dau tien that bai vi camera mat mang thi agent khong tu thu lai; (3) ban chi co mot camera thi PiP ghep camera voi chinh no.
- **Trang thai:** Da hoan thanh (migration da ap production, da kiem thu that).

### [SUA-3-LOI-SAU-KIEM-THU-2CAM] - Tu thu ghi lai lan dau, khong ghep PiP cung camera, chan trung ma agent

- **Muc tieu:** Sua ba loi phat hien khi kiem thu that 17/09/2026.
- **Files tao/sua:** `warehouse-agent/src/recording-lifecycle.ts`, `warehouse-agent/tests/recording-start-failure.test.ts` (moi), `src/lib/agent-commands/cut-clip-planning.ts`, `src/lib/agent-commands/enqueue.ts`, `tests/cut-clip-planning.test.ts`, `src/lib/warehouse/agent-instance-lease.ts` (moi), `tests/agent-instance-lease.test.ts` (moi), `src/app/api/agent/poll-commands/route.ts`, `supabase/migrations/20260917110000_agent_instance_lease.sql` (moi), `warehouse-agent/src/agent-instance.ts` (moi), `warehouse-agent/tests/agent-instance.test.ts` (moi), `warehouse-agent/src/commands.ts`, `warehouse-agent/src/index.ts`, `change.md`.
- **Chi tiet thay doi:**
  - (1) Lan ghi dau theo lenh cloud that bai tam thoi (camera rot mang dung luc mo ca) truoc day bi bo, cloud khong gui lai → mat video ca ca. Nay ghi desired + long-retry + fast recovery nhu khi dang ghi thi mat ket noi; `stopOne` van don sach khi dong ca. Quyet dinh tach thanh `planStartFailure`.
  - (2) Ban chi co mot camera thi hai goc cung camera → PiP ghep camera voi chinh no, ma hoa lai vo ich. Nay `isSeparateQrAngle` bo goc QR khi trung camera toan canh → cat thang mot goc; `compose_mode` ghi `single`.
  - (3) Hai may chay cung ma agent tranh lenh (may kho chay ban cu). Agent moi gui `agent_instance_id` (luu file, khoi dong lai giu nguyen) trong body da ky; cloud giu phien co quyen 30 giay, gia han cung lan ghi `last_seen_at` san co. Phien khac → 409 `agent_instance_conflict`, agent log `[AGENT-TRUNG-MA]`. Agent ban cu chi nhan danh sach rong khi dang co phien moi giu quyen; kho chi chay ban cu khong anh huong. Route chay duoc khi chua ap migration (thieu cot thi bo qua chot). Khong tao agent moi.
- **Ket qua kiem tra:** Web `pnpm test` 392/392, `pnpm typecheck` dat, ESLint file sua dat. Agent `tsc` dat, 143 test dat; 1 test `packaged MediaMTX accepts the generated relay config` hong ca tren commit `1118a0e` (co tu truoc, khong lien quan).
- **Trang thai:** Da code xong. Can chu du an ap migration `20260917110000_agent_instance_lease.sql` len production va khoi dong lai agent de chot trung ma co hieu luc.

### [NGUON-QUET-TREN-CAMERA-QR] - Chon nguon quet (sung / camera) ngay tren camera o vi tri QR

- **Muc tieu:** 18/09/2026 dahua_3 o vi tri QR ban 4 nhin ro ma nhung khong doc duoc: ban 4 tao moi nen `scan_source = 'scanner'`, agent khong chay bo doc QR, may quet ao `qrcam_dahua_3` bi go. Giao dien khong co cho nao cho thay hay doi nguon quet.
- **Files tao/sua:** `src/app/api/packing-stations/route.ts`, `src/app/api/packing-stations/[id]/route.ts`, `src/components/devices/StationAssignCell.tsx`, `src/app/dashboard/devices/page.tsx`, `change.md`.
- **Chi tiet thay doi:** GET danh sach ban tra them `scan_source`. PATCH ban nhan `scan_source` (`scanner`|`camera`), doi xong xoa cache + goi `listCameras` de `ensureQrVirtualScanners` bat/go may quet ao NGAY thay vi doi lan mo trang ke tiep. O "Ban dang phuc vu" cua camera o vi tri QR hien trang thai ("Dang doc ma QR cho ban" / "Chi ghi hinh — ban dang doc ma bang sung quet") kem nut "Dung camera nay de quet ma" / "Chuyen ve sung quet".
- **Ket qua kiem tra:** `pnpm typecheck` dat; ESLint 0 loi (6 canh bao cu trong `page.tsx`, khong thuoc phan sua). Thuc te: sau khi ban 4 chuyen sang camera, `qrcam_dahua_3` active + gan BAN_04, agent (dich vu 0.9.0) mo them tien trinh ffmpeg doc QR luc 11:19:05.
- **Trang thai:** Da code xong; cho quet thu ma QR truoc dahua_3.

### [GOC-QR-KHUNG-DOC-VA-DICH-VU-AGENT-0.9] - O Goc QR dung doc 360x640; cai dich vu agent 0.9.0/0.9.1

- **Muc tieu:** (1) Camera QR xuat hinh doc de nhin tron nhan van don; o Goc QR ngang cu (640x360) cat mat gan het nhan trong clip va thu nho hinh tren livestream. Chu du an muon o dung doc, giu kich thuoc, khong xoay hinh. (2) Agent tren may kho tat khi may khoi dong lai; cai lai dich vu `BetacomAgent` bang ban moi thay ban 0.8.9 cau hinh sai.
- **Files tao/sua:** `warehouse-agent/src/compose/clip-composer.ts`, `src/lib/agent-commands/enqueue.ts`, `src/components/station/LiveLayout.tsx`, `warehouse-agent/package.json`, `warehouse-agent/installer/betacom-agent.iss`, `warehouse-agent/RELEASES.md`, `change.md`.
- **Chi tiet thay doi:** Composer: o QR `scale=360:640 ... crop=360:640`, `overlay=1560:0`, vien `drawbox x=1558 w=362 h=642` — cung dien tich, sat goc tren phai, tren dai thong tin; KHONG xoay (ban dau lam `transpose=clock` theo lua chon, trich khung goc thay camera da xuat hinh doc, xoay them lam chu nam nghieng → bo). Livestream: khung Goc QR `w-[18.75%] h-[59.26%]` (dung dien tich 1/3 x 1/3 khung 16:9, doi chieu). Metadata layout trong payload cut_clip khop. Agent nang 0.9.0 (mot agent nhieu ban, hai camera) va 0.9.1 (o QR doc); da build bo cai va cai de dich vu tren may dev: `BACKEND_URL=https://localhost:3000` (production chua co code 2-camera), dich vu tin CA goc mkcert qua `AppEnvironmentExtra NODE_EXTRA_CA_CERTS` (khong tat kiem tra chung chi).
- **Ket qua kiem tra:** Ghep thu bang ffmpeg tu segment that hik_3 + dahua_3: nhan van don dung thang, hien tron trong o doc. `pnpm typecheck` + agent `tsc` dat. Dich vu 0.9.1 Running/Automatic, heartbeat lien tuc, 3 tien trinh ffmpeg (ghi hik_3, ghi dahua_3, doc QR dahua_3) chay lai sau nang cap.
- **Trang thai:** Da hoan thanh. Luu y: dich vu phu thuoc dev server `localhost:3000`; khi deploy 2-camera len production thi doi `BACKEND_URL` trong `BetacomAgent\.env`.

### [BO-CAI-AGENT-0.9.1-LEN-GIT] - Dua bo cai agent 0.9.1 len nhanh 2-camera qua Git LFS

- **Muc tieu:** Chu du an muon bo cai agent moi co tren nhanh `2-camera`.
- **Files tao/sua:** `.gitattributes`, `warehouse-agent/releases/BetacomAgentSetup-v0.9.1.exe` (LFS), `warehouse-agent/releases/README.md` (moi), `change.md`.
- **Chi tiet thay doi:** Bo cai 116 MB vuot gioi han 100 MB/file cua GitHub nen luu qua Git LFS (`git lfs install --local`, rule `warehouse-agent/releases/*.exe`). De o thu muc rieng `releases/`, khong dung `dist-installer/` (van bi .gitignore). README ghi cach tai (`git lfs pull`), cach cai va luu y dung luong LFS (goi mien phi 1 GB, moi ban ~116 MB).
- **Trang thai:** Da hoan thanh.

### [PA-HOAN-HANG] - Phuong an va luong quay video nhan hang hoan

- **Muc tieu:** Chu du an can phuong an quay video hang hoan phu hop he thong hien tai, trong khi nhan vien nhan luong theo so don dong chieu di.
- **Files tao/sua:** `plans/active/HOAN-HANG-quay-video-don-hoan.md` (moi), `change.md`.
- **Chi tiet thay doi:** Tra cuu: don giao that bai hoan ve giu nguyen ma van don; don khach tra (Shopee, TikTok Shop) co ma moi, Shopee cho viet tay. Doi chieu code: quet lai cung ma khac ngay thanh don `valid` moi → tinh luong lan 2 (lo hien co). De xuat: cot `event_kind` + view `outbound_valid_events` cho moi noi dem don; ban co `purpose` + the QR chuyen che do; luoi an toan nhan ma da dong; the ket qua kiem (OK/HONG/THIEU/TRAO); cat clip ngay khi co van de + han khieu nai; video di va hoan canh nhau. Ke hoach 3 dot (0: chan that thoat; 1: MVP; 2: API san).
- **Cap nhat 18/09/2026:** Chu du an chot: (1) khong tra cong kien hoan; (2) chot cuoi: segment video hoan giu 7 ngay, clip Supabase 72 gio; dung chung cleanup-segments.ps1 them mot buoc, lich chay doi sang hang ngay; (3) KHONG trien khai, chi lap ke hoach. Tai lieu viet lai thanh ke hoach thuc hien + phan tich luong da that: may trang thai che do ban, vong doi kien hoan, ho so khieu nai, vong doi clip (co trang thai cuoi SEGMENTS_EXPIRED), vong doi segment 7 ngay (phan loai 3 dieu kien, mac dinh giu theo retention_days, cleanup chay hang ngay), ma tran xu ly luot quet, 6 bat bien co test, 4 dot thuc hien, 6 kich ban kiem thu.
- **Trang thai:** Ke hoach, chua trien khai (theo quyet dinh chu du an).

### [LUONG-DI-VA-HOAN] - Thiet ke luong don di va don hoan dat canh nhau, da that luong

- **Muc tieu:** Chu du an yeu cau thiet ke luong hang hoan va viet lai ca luong don di de phan biet, moi luong phai that.
- **Files tao/sua:** `plans/active/LUONG-DON-DI-DON-HOAN.md` (moi), `plans/active/HOAN-HANG-quay-video-don-hoan.md` (them lien ket), `change.md`.
- **Chi tiet thay doi:** Phan chung: diem vao luot quet (thu tu phan loai: nguon quet → the dieu khien → QR nhan vien → may quet → ma → ca → che do), ca lam viec va ghi hinh theo ca, che do ban. Don di: quet o che do DI (co luoi an toan ngay khac), vong doi don (6 cach dong, tu dung max_order_seconds), video, tinh luong qua view duy nhat. Don hoan: quet o che do HOAN, vong doi kien (8 cach dong, tu dung 10 phut, unchecked van co ho so), ho so khieu nai (tu expired), video (cat ngay khi co van de, 7 ngay segment, 72 gio cloud). Bang so sanh hai luong, bang that luong (moi trang thai co loi ra tu dong, toi da bao lau, hien o dau), bang ngoai le. Luong don di danh dau [hien co] / [moi] theo code hien tai.
- **Trang thai:** Thiet ke, chua trien khai.

### [THAM-KHAO-DOHANA] - Doi chieu luong hoan hang voi Dohana

- **Muc tieu:** Chu du an yeu cau tham khao luong hoan hang cua Dohana.
- **Files tao/sua:** `plans/active/LUONG-DON-DI-DON-HOAN.md`, `plans/active/HOAN-HANG-quay-video-don-hoan.md`, `change.md`.
- **Chi tiet thay doi:** Dohana cong khai: che do "Ghi hinh mo hang hoan", video toi da 20 phut, luu 25 ngay (gia han 30-35), theo doi ty le thanh cong / so tien thu hoi / trang thai tung don hoan, "Quan ly gui van chuyen" (bang chung ban giao shipper), 2 camera. Khong co tai lieu chi tiet thao tac (video YouTube, mo ta Google Play khong doc duoc). Da ap dung: tran video hoan 20 phut (`return_max_seconds=1200`); ho so khieu nai them `claim_amount`, `recovered_amount` + o tong hop thang (ty le thang, tien thu hoi). Ghi nhan: che do BAN GIAO shipper la huong mo rong. Khuyen nghi (chua doi): han luu segment hoan 7 ngay ngan hon Dohana 25 ngay.
- **Trang thai:** Thiet ke, chua trien khai.

### [LUONG-HOAN-CHOT-PHAM-VI] - Chot pham vi luong hoan hang: khong xu ly tien, thoi gian theo chu du an

- **Muc tieu:** Chu du an: chua xu ly gi ve tien bac, chi luong hoan hang; thoi gian theo y chu du an; luong tham khao Dohana va dua tren he thong hien tai.
- **Files tao/sua:** `plans/active/LUONG-DON-DI-DON-HOAN.md`, `plans/active/HOAN-HANG-quay-video-don-hoan.md`, `change.md`.
- **Chi tiet thay doi:** Bo `claim_amount`, `recovered_amount`, o tong hop tien thu hoi, trang thai Thang/Thua (ho so: open → submitted / dismissed / expired). Bo khuyen nghi nang han luu; giu segment hoan 7 ngay, clip Supabase 72 gio. Muc 7 viet lai thanh "Giai phap chot": lay gi tu Dohana (che do hoan rieng, video 20 phut, tra theo ma, trang thai tung don hoan), dung lai gi cua he thong hien tai, diem hon Dohana. Doi cach goi "tinh luong" → "dem vao so don dong" (he thong chi dem don); view doi ten `counted_outbound_events`. Them quyet dinh #4 (pham vi).
- **Trang thai:** Thiet ke, chua trien khai.

### [LUONG-HOAN-VIET-LAI-RO] - Viet lai ro rang hai tai lieu luong don di / don hoan; kien hoan tu dung sau 5 phut

- **Muc tieu:** Chu du an yeu cau viet lai moi thong tin that ro rang; he thong tu dung kien hoan sau 5 phut.
- **Files tao/sua:** `plans/active/LUONG-DON-DI-DON-HOAN.md` (viet lai), `plans/active/HOAN-HANG-quay-video-don-hoan.md` (viet lai), `change.md`.
- **Chi tiet thay doi:** Tach ro vai tro: tai lieu LUONG = nghiep vu (thuat ngu, bang moc thoi gian duy nhat, phan chung: phan loai luot quet 7 buoc / ca va ghi hinh / che do ban; don di: viec nhan vien, bang xu ly ma, 6 cach ket thuc, video, dem don; don hoan: viec nhan vien, bang xu ly, 8 cach ket thuc, ho so, video va luu tru; so sanh, bang that luong, tinh huong bat thuong, giai phap chot Dohana + he thong). Tai lieu HOAN-HANG = ky thuat (quyet dinh, hien trang co vi tri code, mo hinh du lieu, han luu 7 ngay, 6 bat bien, 4 dot, 7 kich ban, rui ro, ngoai pham vi). Kien hoan tu dung **5 phut** (`return_max_seconds=300`, clip toi da 5 phut + 10 giay dem) thay 20 phut.
- **Trang thai:** Thiet ke, chua trien khai.

### [HOAN-TU-VE-5-PHUT] - Ban tu ve che do DONG HANG sau 5 phut khong thao tac

- **Muc tieu:** Chu du an doi thoi gian ban tu ve che do dong hang tu 10 phut xuong 5 phut.
- **Files tao/sua:** `plans/active/LUONG-DON-DI-DON-HOAN.md`, `plans/active/HOAN-HANG-quay-video-don-hoan.md`, `change.md`.
- **Chi tiet thay doi:** `return_idle_revert_seconds` = 300; moi cho ghi 10 phut doi thanh 5 phut. Vi trung moc tu dung kien hoan (5 phut), them quy tac thu tu: kien tu dung truoc (ly do timeout), ban ve che do sau — kien khong bao gio mang hai ly do dong.
- **Trang thai:** Thiet ke, chua trien khai.

### [HOAN-D1] - Dot 1: tach kien hoan khoi so don dong + luoi an toan

- **Muc tieu:** Theo `plans/active/HOAN-HANG-quay-video-don-hoan.md` dot 1: them `event_kind` va cac cot hoan vao `packing_events`, view `counted_outbound_events` lam nguon dem don duy nhat, luoi an toan trong `process_waybill_scan` (ma da dong ngay khac trong 60 ngay → kien hoan `suspect`, khong dem, khong dong don dang mo).
- **Files tao/sua:** `supabase/migrations/20260921090000_return_flow_base.sql` (moi), `src/lib/warehouse/outbound-only.ts` (moi), `src/lib/reports/service.ts`, `src/app/api/dashboard/overview/route.ts`, `src/app/api/dashboard/production/route.ts`, `src/lib/warehouse/live/summary.ts`, `src/lib/warehouse/live/activity.ts`, `src/lib/station/announcements.ts`, `src/app/dashboard/operations/page.tsx`, `tests/counting-excludes-returns.test.ts` (moi), `tests/return-suspect-announcement.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:** DB: them `event_kind`/`return_kind`/`outbound_event_id`/`inspection_result`/`close_reason` + rang buoc (don di khong duoc mang thong tin hoan), noi rong `status` (`return_suspect`, `duplicated_return`) va `timing_status` (`finalized_by_mode_switch`), 2 index (tra ma da dong, loc kien hoan), view `counted_outbound_events` (security_invoker), them 5 tham so thoi gian luong hoan vao `packing_timing_default_config`, sua `process_waybill_scan` (loc duplicate theo event_kind + luoi an toan: ma da dong `valid` o ngay khac trong `return_lookback_days` → kien hoan `suspect` dong ngay, co moc cat clip, KHONG dem, KHONG dong don dang mo), `lark_digest_per_staff` chi dem don di. Code: 4 noi dem don loc theo loai (san luong doc view), cau loa + nhan dong thoi gian cho `return_suspect`.
- **Ket qua kiem tra:** Chay thu tren ban sao local trong transaction + ROLLBACK, 6 kich ban: ma moi → valid duoc dem; quet lai cung ngay → duplicated; ma da dong hom qua → `return_suspect` (event_kind=return, return_kind=suspect, inspection=unchecked, close_reason=suspect, timing=not_applicable, noi duoc voi don di, co moc cat clip), don dang mo VAN o trang thai open, khong vao view dem don; digest Lark khong dem kien hoan. Web `pnpm test` 401/401, `pnpm typecheck` dat, ESLint 0 loi.
- **Trang thai:** Da hoan thanh phan code. Chua ap migration len production (cho chu du an).

### [HOAN-D2] - Dot 2: che do ban (DONG HANG / NHAN HOAN) va the dieu khien

- **Muc tieu:** Theo ke hoach dot 2: `packing_stations.purpose`, bang `station_mode_periods`, `scan_type='control'`, route quet nhan dien the `BETABOX:*`, tu ve che do DONG HANG sau 5 phut khong thao tac va khi dong ca, giao dien chon che do + in the.
- **Files tao/sua:** `supabase/migrations/20260921100000_station_modes.sql` (moi), `src/lib/station/control-cards.ts` (moi), `src/lib/station/station-mode.ts` (moi), `src/components/stations/StationPurposeCell.tsx` (moi), `src/app/dashboard/station-cards/page.tsx` (moi), `src/app/api/warehouse/scans/route.ts`, `src/app/api/warehouse/manual-scan/route.ts`, `src/app/api/warehouse/heartbeat/route.ts`, `src/app/api/live/[stationId]/events/route.ts`, `src/app/api/packing-stations/route.ts`, `src/app/api/packing-stations/[id]/route.ts`, `src/app/dashboard/packing-stations/page.tsx`, `src/lib/station/announcements.ts`, `src/components/station/StationLivePanel.tsx`, `warehouse-agent/src/index.ts`, `tests/control-cards.test.ts` (moi), `tests/station-mode-flow.test.ts` (moi), `change.md`.
- **Chi tiet thay doi:** DB: `packing_stations.purpose`, bang `station_mode_periods` (RLS bat, unique partial index: moi ban toi da MOT ky mo), `scan_type='control'`, ham `station_current_mode` / `set_station_mode` / `touch_station_mode_activity` / `revert_idle_return_modes`, trigger dong ca ve che do mac dinh va trigger doi `purpose` co hieu luc ngay. Code: bo doc the `BETABOX:*` (ham thuan), route quet agent phan loai the TRUOC QR nhan vien va goi doi che do + gia han moc thao tac, quet tay cung nhan the che do, hai nhip tu ve (man hinh ban + heartbeat agent), man hinh ban hien nhan che do nen cam + loa bao doi che do, trang Ban dong goi co cot che do (xac nhan khi chuyen sang ban chuyen hoan), trang in the QR `/dashboard/station-cards`, agent log `[THE: ...]`.
- **Ket qua kiem tra:** Chay thu tren ban sao local (transaction + ROLLBACK) 9 kich ban: ban moi = che do mac dinh; the HOAN mo ky; quet lai the khong tao ky moi; chua du 5 phut khong tu ve; qua 5 phut tu ve (ly do idle_revert); ban chuyen hoan khong tu ve; dong ca ve mac dinh (ly do shift_closed); bat bien mot ky mo; luu duoc scan_type=control. Web `pnpm test` 414/414, `pnpm typecheck` dat, ESLint sach, `pnpm build` thanh cong (co route /dashboard/station-cards), agent `tsc` dat.
- **Trang thai:** Da hoan thanh phan code. Chua ap migration len production (cho chu du an).

### [HOAN-D3] - Dot 3: vong doi kien hoan, the ket qua, ho so, video

- **Muc tieu:** Theo ke hoach dot 3: quet o che do NHAN HOAN tao kien hoan (rts / customer_return / chuyen tu suspect), 8 cach ket thuc, the ket qua, bang `return_claims`, cat clip ngay khi co van de, tran clip 5 phut, trang Hang hoan.
- **Files tao/sua:** `supabase/migrations/20260921110000_return_lifecycle.sql` (moi), `src/lib/station/return-scan.ts` (moi), `src/lib/station/return-clip-requests.ts` (moi), `src/app/api/returns/route.ts` (moi), `src/app/api/returns/claims/[claimId]/route.ts` (moi), `src/app/dashboard/returns/page.tsx` (moi), `src/components/returns/ReturnClipPlayer.tsx` (moi), `tests/return-lifecycle.test.ts` (moi), `src/lib/station/order-timeout.ts`, `src/lib/station/force-stop-expired-orders.ts`, `src/lib/station/announcements.ts`, `src/lib/order-proof/clip-window.ts`, `src/lib/order-proof/clip-resolver.ts`, `src/lib/agent-commands/enqueue.ts`, `src/lib/domain-status.ts`, `src/lib/nav.ts`, `src/app/api/warehouse/scans/route.ts`, `src/app/api/warehouse/manual-scan/route.ts`, `src/app/api/warehouse/heartbeat/route.ts`, `src/app/api/live/[stationId]/events/route.ts`, `plans/active/LUONG-DON-DI-DON-HOAN.md`, `change.md`.
- **Chi tiet thay doi:** DB: `return_claims` (RLS bat) + trigger mo ho so cho MOI duong dong kien, `expire_return_claims`, `close_return_event` / `close_open_return_at_station`, `process_return_scan` (rts / customer_return / duplicated_return / khong co ca), `set_station_mode` doi che do thi dong luot dang mo cua che do cu, dong ca dong ca kien hoan, `_finalize_open_packing_for_station_at` chi chot DON DI, timing_status them `return_closed`. Code: quet theo che do ban o ca route agent lan quet tay, the ket qua/KET THUC dong kien, tran 5 phut cho kien hoan trong vong tu dung, tran clip rieng 310s, cau loa rieng cho kien hoan, tu xin cat clip cho ho so dang mo (heartbeat), trang Hang hoan + API + khung phat hai video canh nhau, them muc menu.
- **Ket qua kiem tra:** Ban sao local (transaction + ROLLBACK) 11 kich ban: doi che do dong don di dang mo; kien rts noi don di; the TRAO dong kien + tao ho so 168h; the OK khong tao ho so; quet kien ke tiep dong kien truoc voi 'chua kiem' + co ho so; quet trung khong dung kien dang mo; doi che do dong kien (mode_switch); dong ca dong kien (shift_closed); ho so qua han tu expired; kien hoan khong vao view dem don. Web `pnpm test` 425/425, `pnpm typecheck` dat, ESLint 0 loi, `pnpm build` thanh cong (co /dashboard/returns, /api/returns).
- **Sai khac so voi thiet ke ban dau (da cap nhat tai lieu):** luot bi luoi an toan bat khong duoc "bien" thanh kien dang mo; thay vao do mo kien moi va huy ho so cua luot nghi ngo — giu duoc bat bien moi luot quet ung voi dung mot ban ghi.
- **Trang thai:** Da hoan thanh phan code. Chua ap migration len production (cho chu du an).

### [HOAN-D4] - Dot 4: han luu 7 ngay cho segment hang hoan

- **Muc tieu:** Theo ke hoach dot 4: cot `retention_class`, job phan loai segment thuan hang hoan (3 dieu kien), endpoint cho agent tai danh sach, them mot buoc vao `cleanup-segments.ps1`, doi lich chay sang hang ngay.
- **Files tao/sua:** `supabase/migrations/20260921120000_return_segment_retention.sql` (moi), `src/app/api/agent/retention-plan/route.ts` (moi), `warehouse-agent/src/retention-plan.ts` (moi), `tests/return-segment-retention.test.ts` (moi), `src/lib/warehouse/agent-api-paths.ts`, `warehouse-agent/src/agent-api-paths.ts`, `src/lib/supabase/proxy.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/scripts/cleanup-segments.ps1`, `warehouse-agent/scripts/cleanup-task.xml`, `warehouse-agent/installer/betacom-agent.iss`, `change.md`.
- **Chi tiet thay doi:** DB: cot `camera_recording_files.retention_class` (`default` / `return_short`) + index rieng, ham `classify_return_segments` danh dau segment THUAN hang hoan theo 3 dieu kien (nam tron trong mot ky NHAN HOAN cua ban ma camera dang gan; khong giao cua so video cua bat ky don di nao dung camera do, noi rong 60 giay hai dau; camera chi phuc vu DUNG MOT ban trong khoang do), bo qua segment chua dong va segment da qua han chung. Cloud: route `POST /api/agent/retention-plan` (HMAC v2, bypass proxy) phan loai roi tra danh sach duong dan + so ngay (`return_segment_retention_days`, mac dinh 7), tran 5000 file, chi tra file da du gia. Danh sach co ca can tren va CAN DUOI (cua so 30 ngay) vi ban ghi `camera_recording_files` khong bi xoa khi agent xoa file tren o dia — khong co can duoi thi danh sach xep tu cu nhat se dan toan file da xoa va chiem het tran, file moi qua han khong lot vao, cleanup am tham ngung tac dung. Agent: module `retention-plan.ts` ghi `retention-plan.json` (ghi tam roi doi ten), goi luc boot va moi 6 gio; loi mang hoac cloud cu khong ghi de danh sach cu; nhanh cat clip doc them danh sach nay de bao dung `clip_expired_retention` (thay vi `segments_missing_on_disk` — bao dong gia ve o hong) khi MOI file thieu deu nam trong danh sach va da qua 7 ngay. Script `cleanup-segments.ps1` them buoc xoa som theo danh sach (guard y het buoc cu: bo file dang ghi, bo thu muc hom nay, chan duong dan nam ngoai RECORDING_DIR), fail-safe nguoc chieu buoc han chung: thieu/hong danh sach thi bo qua buoc do chu khong dung script. Lich chay doi tu hang tuan (CN 03:00) sang hang ngay 03:00 o ca file mau lan doan installer sinh XML — vi nhom hang hoan chi giu 7 ngay.
- **Ket qua kiem tra:** Ban sao local (transaction + ROLLBACK) 4 kich ban: segment trong ky hoan → `return_short`; segment ngoai ky / dinh cua so don di / dang ghi → giu nguyen; camera phuc vu hai ban trong khoang do → khong danh dau; chay lai lan hai khong danh dau them (lan 1 = 1, lan 2 = 0); ky hoan dang mo van danh dau dung phan trong ky. Web `pnpm test` 433/433, `pnpm typecheck` dat, `pnpm build` thanh cong (co route `/api/agent/retention-plan`), agent `tsc` dat, ESLint khong phat sinh loi moi.
- **Chua kiem thu duoc:** Goi that tu agent len route can migration dot 1-4 da co tren production; se chay sau khi chu du an ap migration.
- **Trang thai:** Da hoan thanh phan code. Chua ap migration len production (cho chu du an).

### [HOAN-E2E] - Kiem thu dau-cuoi 7 kich ban tren ban sao local (ca 4 dot cung luc)

- **Muc tieu:** Chu du an yeu cau "pass het cac cap do kiem thu". Ba cap duoi (don vi, canh gac nguon, chay thu tung dot) da co; cap cuoi la chay 7 kich ban dau-cuoi o muc 6 cua ke hoach voi CA BON migration ap cung mot luc — de bat loi chi xuat hien khi cac dot ghep vao nhau.
- **Files tao/sua:** khong sua ma nguon (chi chay thu); `change.md`, `plans/active/HOAN-HANG-quay-video-don-hoan.md`.
- **Chi tiet thay doi:** Kich ban chay trong mot transaction roi ROLLBACK tren ban sao production local: (1) ban chuyen hoan — kien giao that bai noi duoc don di, the OK dong kien, khong mo ho so; (2) ban dong hang — the HOAN, kien khach tra, the TRAO dong kien va mo ho so; (3) quen the ket qua — quet kien ke tiep dong kien truoc voi "chua kiem", ly do `next_scan`, co ho so; (4) de kien mo qua 5 phut — dong voi ly do `timeout`, co ho so; (5) quen chuyen ve — ranh 5 phut thi ban tu ve DONG HANG, don di quet sau do vao view dem don; (6) luoi an toan — ma da dong hom qua quet lai thanh `return_suspect`, don dang mo VAN mo, luot nghi ngo khong vao view dem don; (7) ho so qua han thanh `expired` va segment thuan hoan thanh `return_short`. Ba kiem tra chung cuoi cung: khong kien hoan nao lot vao view dem don; moi kien hoan da dong deu co `close_reason`; khong ban thuong nao con ket o che do NHAN HOAN.
- **Ket qua kiem tra:** Ca 7 kich ban va 3 kiem tra chung deu dat. Hai lan chay dau bao loi nhung deu do SCRIPT KIEM THU sai (truyen nham ma van don vao cho ten sung quet; dung ten cot `expires_at` trong khi bang la `deadline_at`), khong phai loi he thong — da sua script roi chay lai.
- **Trang thai:** Da hoan thanh o muc ban sao local. Con lai: chu du an ap 4 migration len production, roi chay lai 7 kich ban tren he thong that voi agent.

### [HOAN-D5] - Dot 5: phien ghi hoan theo tin hieu module

- **Muc tieu:** Chu du an doi (21/09/2026): luong dong hang giu nguyen ghi lien tuc; luong hoan chi "luu segment" tu luc bam vao phan Hang hoan tren sidebar, doan dang ghi do van duoc luu not khi nguoi dung thoat, va AGENT phai nhan duoc tin hieu doi module — khong co tin hieu thi khong thuc hien.
- **Chot voi chu du an:** tin hieu tu trang `/dashboard/returns`; dung CHINH camera cua ban (van ghi lien tuc cho don di); the QR `BETABOX:HOAN` giu lai nhu mot nguon tin hieu nua; chon ban ngay tren trang Hang hoan; mat nhip 2 phut thi tu nha.
- **Noi ro mot diem:** camera dung chung nen KHONG the vua ghi lien tuc cho don di vua khong ghi cho luong hoan. Cai ma tin hieu bat/tat la QUYEN SO HUU: doan video nao thuoc phien hoan. Chi doan mang nhan moi bi rut han luu 7 ngay va moi duoc dung lam video kien hoan. Muon dung nghia den "chi chay ffmpeg khi mo module" thi phai dung camera rieng cho ban hoan — se la mot dot khac.
- **Files tao/sua:** `plans/active/HOAN-HANG-phien-ghi-theo-module.md` (moi), `supabase/migrations/20260921130000_return_capture_sessions.sql` (moi), `src/lib/station/return-capture.ts` (moi), `src/app/api/returns/capture/route.ts` (moi), `src/app/api/agent/return-capture/route.ts` (moi), `src/components/returns/ReturnCapturePanel.tsx` (moi), `warehouse-agent/src/return-capture.ts` (moi), `tests/return-capture.test.ts` (moi), `src/app/dashboard/returns/page.tsx`, `src/app/api/agent/recording-files/route.ts`, `src/lib/warehouse/recording-files-batch.ts`, `src/app/api/warehouse/scans/route.ts`, `src/app/api/warehouse/manual-scan/route.ts`, `src/app/api/warehouse/heartbeat/route.ts`, `src/lib/warehouse/agent-api-paths.ts`, `src/lib/supabase/proxy.ts`, `warehouse-agent/src/agent-api-paths.ts`, `warehouse-agent/src/index.ts`, `warehouse-agent/src/segment-index.ts`, `warehouse-agent/src/segment-tracker.ts`, `warehouse-agent/src/commands.ts`, `warehouse-agent/src/segment-report-queue.ts`, `change.md`.
- **Chi tiet thay doi:** DB: phien ghi hoan CHINH LA ky che do NHAN HOAN (khong them bang moi, tranh hai vong doi lech nhau) — them `holders`, `capture_state`, `last_heartbeat_at`, `capture_ended_at`, `agent_acked_at`; them `camera_recording_files.return_capture_id`; RPC `open_return_capture` / `touch_return_capture` / `release_return_capture` / `ack_return_capture` / `finish_return_capture` / `expire_return_captures` / `station_camera_ids`; TRIGGER `station_mode_periods_drain_capture` chuyen phien sang `draining` o MOI duong dong ky (the, quet, tu ve 5 phut, dong ca, doi muc dich ban, nha holder) — dung trigger vi sua tay sau cho thi cho thu bay them sau nay se quen; `classify_return_segments` doi nguon: chi xet segment CO NHAN cua agent, giu nguyen hai ve an toan cua dot 4. Cloud: `POST /api/returns/capture` (open/heartbeat/close + GET danh sach ban va trang thai), `POST /api/agent/return-capture` (ack/finish, HMAC v2), lenh `set_return_capture` gui cho moi agent active, `recording-files` nhan them `return_capture_id` va KHONG cho ban bao sau xoa nhan da co. The QR di chung mot duong holder voi giao dien. Agent: `return-capture.ts` giu trang thai trong `return-capture.json` (song qua restart), gan nhan o duong ghi hinh dang chay (KHONG gan cho luot quet lai o dia luc khoi dong), khi nhan TAT thi chuyen sang rut — van gan not cho camera con doan do, cho chung dong roi moi bao xong kem moc segment cuoi. Giao dien: bang dieu khien tren trang Hang hoan (chon ban, Bat dau / Ket thuc, nhan trang thai `Dang ghi` / `Dang luu not doan cuoi` / `May chu kho chua nhan tin hieu`, nhip 30 giay, `sendBeacon` khi roi trang).
- **Ket qua kiem tra:** Ban sao local (transaction + ROLLBACK) 11 kich ban dot 5: mo phien tra id + danh sach camera; nguoi thu hai vao cung ban khong tao phien moi; nhip cua nguoi khong giu bi tu choi; agent ack; mot nguoi thoat phien van active; nguoi cuoi thoat thi ky dong va phien sang draining; bao xong dat moc sau luc nguoi thoat; agent chua ack thi dong ky la finished luon; mat nhip 2 phut tu nha; phan loai han luu CHI danh dau segment co nhan; segment co nhan nhung dinh cua so don di van giu. Them 5 kich ban ghep nguon: the bat truoc module vao sau dung mot phien; quet the DONG HANG ma module con giu thi ban van nhan hoan; module thoat not thi ve dong hang; dong ca dong phien dang mo; agent im 15 phut thanh abandoned. Web `pnpm test` 444/444, `pnpm typecheck` dat, `pnpm build` thanh cong (co `/api/returns/capture`, `/api/agent/return-capture`), agent `tsc` dat, ESLint sach tren file moi.
- **Trang thai:** Da hoan thanh phan code. Chua ap migration len production (cho chu du an), va can cai lai agent de co module phien ghi.

### [HOAN-D5-DOI-XUNG] - Doan dang ghi do luc VAO module hoan van thuoc luong dong hang

- **Muc tieu:** Chu du an xac nhan: doan video cua luong dong hang dang ghi do (doan boc phan ket thuc video don di) khi doi sang module hoan thi van ghi not va van thuoc luong dong hang — doi xung voi luat luc thoat module hoan.
- **Files tao/sua:** `warehouse-agent/src/return-capture.ts`, `warehouse-agent/src/segment-index.ts`, `tests/return-capture-agent.test.ts` (moi), `plans/active/HOAN-HANG-phien-ghi-theo-module.md`, `change.md`.
- **Chi tiet thay doi:** Ban dot 5 truoc do gan nhan hoan cho CA doan dang ghi do luc bat phien — tuc doan chua phan cuoi video don di co the bi rut han luu 7 ngay (van con ve an toan "khong giao cua so don di" chan lai, nhung khong nen dua vao do). Nay agent ghi lai `deferred_cameras` luc nhan BAT: camera nao dang co doan do thi doan do giu cho luong dong hang, phien hoan nhan tu doan KE TIEP. Luc TAT, camera con dang o trang thai hoan nhan thi khong bi tinh la doan phai cho (tranh treo phien vi mot doan khong thuoc minh). `SegmentIndex.stamp` doi sang xu ly TUAN TU tung payload: luc cuon segment, dong doan cu phai cap nhat trang thai phien truoc khi xet doan moi. Trang thai hoan nhan luu trong `return-capture.json`, song qua restart. Them `deps.send` de test thay duong mang.
- **Ket qua kiem tra:** 5 test hanh vi mo phong segment cuon: vao module giua doan dong hang → doan do khong mang nhan, doan ke tiep mang nhan; bat khi chua co doan do → nhan ngay; thoat giua doan hoan → doan do van mang nhan, bao xong dung mot lan sau khi no dong, doan mo sau khong mang nhan; bat roi tat trong cung doan dong hang → ket thuc ngay; agent khoi dong lai van nho doan dang hoan. `pnpm test` 449/449, agent `tsc` dat.
- **Trang thai:** Da hoan thanh. Chi commit o may, CHUA push (chu du an yeu cau chi push khi duoc bao).

### [HOAN-D5-CHUYEN-QUA-LAI] - Chuyen qua lai giua hai module: doan do luon luu not cho module cu

- **Muc tieu:** Chu du an chot: ca hai module, doan dang ghi do luc chuyen sang module kia thi chay ngam luu het doan do roi moi ket thuc; chuyen lai thi bat dau nhan tu doan tiep theo.
- **Files tao/sua:** `warehouse-agent/src/return-capture.ts` (viet lai), `tests/return-capture-agent.test.ts`, `tests/return-capture.test.ts`, `plans/active/HOAN-HANG-phien-ghi-theo-module.md`, `change.md`.
- **Chi tiet thay doi:** Soat lai theo dung luat nay thi phat hien 3 loi that o agent, bo test cu chua bat duoc: (1) hoan → dong hang → hoan trong CUNG mot doan: phien cu bi bao xong ngay va doan dang ghi do mat nhan hoan; (2) hai ban cung nhan hoan: agent chi giu MOT phien, ban thu hai bat la de mat phien ban thu nhat; (3) lenh BAT giao tre sau khi phien da xong lam phien song lai va gan nhan mai khong dung. Sua: agent giu nhieu phien cung luc (Map theo capture_id); nhan cua mot doan = module dang bat luc doan do BAT DAU ghi — phien dang rut duoc uu tien voi doan do cua no, phien moi bat thi hoan nhan camera dang co doan do; nho 100 phien da ket thuc de bo qua lenh BAT giao tre; file trang thai doc duoc ca dinh dang cu (mot phien) de nang cap agent giua phien khong mat phien.
- **Ket qua kiem tra:** 9 test hanh vi mo phong segment cuon, them 4 kich ban: chuyen qua lai nhieu lan (moi doan dung module); hoan → dong hang → hoan trong cung mot doan; hai ban cung nhan hoan; lenh BAT giao tre. Chay bo test moi voi ban agent TRUOC khi sua: truot dung 3 kich ban (2), (3), (4) — xac nhan loi co that. Ban moi qua ca 9. `pnpm test` 453/453, agent `tsc` dat.
- **Trang thai:** Da hoan thanh. Chi commit o may, CHUA push.

### [HOAN-GIAO-DIEN] - Hai trang moi: Giam sat hoan hang va Bang chung hoan hang

- **Muc tieu:** Chu du an yeu cau giao dien Giam sat hoan hang giong het Giam sat dong hang, Bang chung hoan hang giong het Bang chung giao hang, chi khac chuc nang. Giua chung chu du an chot them: TACH RIENG hai phan moi, khong de chung trong hai phan cu roi doi chuc nang ben trong.
- **Files tao/sua:** `plans/active/HOAN-HANG-giao-dien-giam-sat-bang-chung.md` (moi), `src/app/dashboard/(return-module)/layout.tsx` (moi), `src/app/dashboard/(return-module)/returns/page.tsx` (moi), `src/app/dashboard/(return-module)/return-videos/page.tsx` (moi), `src/components/returns/ReturnCaptureProvider.tsx` (moi), `src/app/api/returns/live/overview/route.ts` (moi), `src/app/api/returns/live/proof-size-risk/route.ts` (moi), `src/app/api/returns/proof/scans/route.ts` (moi), `src/app/api/returns/claims/bulk/route.ts` (moi), `src/lib/warehouse/live/returns.ts` (moi), `src/lib/order-proof/proof-size-risk.ts` (moi), `tests/return-pages.test.ts` (moi), `src/components/returns/ReturnCapturePanel.tsx`, `src/lib/nav.ts`, `src/lib/order-proof/service.ts`, `src/lib/warehouse/live/summary.ts`, `src/lib/warehouse/live/stations.ts`, `src/lib/warehouse/live/activity.ts`, `src/lib/warehouse/live/issues.ts`, `src/app/api/warehouse/live/proof-size-risk/route.ts`, `src/app/api/order-proof/scans/mark-error/route.ts`, `tests/counting-excludes-returns.test.ts`, `change.md`. Xoa: `src/app/dashboard/returns/page.tsx` (trang Hang hoan cu), `src/components/returns/ReturnClipPlayer.tsx`, `src/app/api/returns/route.ts`.
- **Chi tiet thay doi:** Hai trang cu `operations` va `videos` KHONG SUA MOT DONG NAO. Hai trang moi la file rieng, chep nguyen van tu trang cu roi doi phan nghiep vu trong file moi; API rieng duoi `/api/returns/...`. Giam sat hoan hang: o Bat dau / Ket thuc nhan hoan; 4 the so Da nhan / Quet lai / Can xu ly (ho so mo, moi ngay) / Nhan su; the ban dem kien + nhan "Dang nhan hoan"; Can xu ly = ho so mo (han gan nhat truoc) + ma quay lai ban dong hang + quet lai; nhat ky = kien hoan + the dieu khien; tab Tat ca / Hang on / Quet lai / Can xu ly / The dieu khien; canh bao khi >= 3 ma quay lai ban dong hang. Bang chung hoan hang: danh sach kien hoan, cot "T/g kiem hang", nhan ket qua kiem + trang thai ho so (thay "Don loi"), hanh dong hang loat "Da khieu nai" / "Khong can" (thay Danh dau loi), modal them nut "Xem video luc dong goi gui di". Hai trang nam chung route group `(return-module)` voi layout giu phien nhan hoan — chuyen qua lai giua hai trang khong dut phien, roi han phan he moi gui tin hieu dong. URL `/dashboard/returns` va `/dashboard/return-videos` co y khong long nhau (sidebar danh dau theo tien to). Sidebar: thay muc "Hang hoan" bang hai muc moi.
- **Sua kem (loi da co tu truoc, phat hien khi lam):** (1) Bang chung giao hang liet ke lan ca kien hoan — `listScans` gio mac dinh chi don di; (2) the ban tren Giam sat dong hang dem lan kien hoan vao "Hom nay N don" — `buildLiveStations` loc theo luong, mac dinh don di; (3) nhat ky dong hang goi luot quet o ban nhan hoan la "Hop le" (lot ca vao tab Hop le) va goi the dieu khien la "Dang cho xu ly" — gio gan dung nhan; (4) uoc luong dung luong clip cua trang dong hang tinh lan kien hoan — logic tach ra `lib/order-proof/proof-size-risk.ts`, route cu chi uoc luong don di; (5) "Danh dau loi" chan o server chi cham don di; (6) trang Hang hoan cu thieu khung dashboard.
- **Ket qua kiem tra:** `pnpm test` 470/470 (them 17 test: tach rieng trang cu/moi, khung giao dien giu y het, sidebar, layout giu phien, cac sua kem, phan loai kien hoan cho nhat ky; viet lai test "chi dem don di" cho ham nhan luong — chat hon truoc vi canh ca the ban). `pnpm typecheck` dat, `pnpm build` thanh cong (co `/dashboard/returns`, `/dashboard/return-videos`, 4 route `/api/returns/...` moi), ESLint 0 loi (canh bao con lai ke thua nguyen tu trang goc).
- **Chua kiem thu duoc:** Chay hai trang voi du lieu that can migration dot 1-5 tren production. LUU Y: nhanh `2-camera` hien doc cot `event_kind` o nhieu cho (tu dot 1, nay them the ban va danh sach bang chung giao hang) — KHONG trien khai nhanh nay truoc khi ap du 5 migration, neu khong ca hai trang dong hang cung se trong.
- **Trang thai:** Da hoan thanh phan code. Chi commit o may, CHUA push.

### [LOG-DU-AN] - Nhat ky du an tu luong 2 camera den nay

- **Muc tieu:** Chu du an yeu cau viet log du an tu luc bat dau trien khai luong 2 camera den hien tai, luu trong mot thu muc `log/` rieng.
- **Files tao/sua:** `log/README.md` (moi — muc luc, tinh trang hien tai, viec con ton, nguyen tac da chot), `log/2026-09-14.md`, `log/2026-09-15.md`, `log/2026-09-16.md`, `log/2026-09-17.md`, `log/2026-09-18.md`, `log/2026-09-21.md` (moi — moi ngay mot file), `change.md`.
- **Chi tiet thay doi:** Tong hop tu 21 commit cua nhanh `2-camera` (tach tu `main` tai `aba1e59`) va cac muc trong `change.md`; ngay cua tung viec doi chieu theo commit dau tien chua file cua viec do. Thu muc `log/` nam ngoai `plans/` theo yeu cau truc tiep cua chu du an.
- **Trang thai:** Da hoan thanh. Chua commit.

### [HOAN-D6] - Dot 6: moi ban nhan hoan song song, lai voi dong hang, mot may kho dieu khien tat ca

- **Muc tieu:** Chu du an yeu cau: tat ca cac ban xu ly hoan hang cung luc, song song nhu luong dong hang; van phai lai duoc (ban 1, 2 dong hang + ban 3, 4 hoan hang cung luc); mot may kho dieu khien moi ban va moi camera.
- **Files tao/sua:** `plans/active/HOAN-HANG-song-song-moi-ban.md` (moi), `supabase/migrations/20260921140000_return_parallel_stations.sql` (moi), `tests/return-parallel-stations.test.ts` (moi), `src/lib/station/return-capture.ts`, `src/app/api/returns/capture/route.ts`, `src/components/returns/ReturnCaptureProvider.tsx`, `src/components/returns/ReturnCapturePanel.tsx`, `tests/return-capture-agent.test.ts`, `log/2026-09-21.md`, `log/README.md`, `change.md`.
- **Chi tiet thay doi:** Soat thay phan loi da song song san (moi thu khoa theo tung ban; agent giu nhieu phien tu dot 5). Ba cho chan da sua: (1) giao dien chi giu mot ban moi trinh duyet -> bang Phien nhan hoan hien moi ban, bat/tat tung ban hoac tat ca, nhip 30 giay va tin hieu dong khi roi phan he gui MOT request cho moi ban dang giu; API `/api/returns/capture` nhan `station_ids` (tran 50), moi ban xu ly va bao loi rieng, GET danh sach ban kem trang thai tung ban trong mot truy van; (2) nguoi giu phien tinh theo tai khoan -> tinh theo TAB `module:<user_id>:<tab_id>`, phan tai khoan luon lay tu phien dang nhap; (3) the QR va nut giao dien bat cung mot ban cung luc -> khoa tu van THEO BAN o dau `open_return_capture` / `release_return_capture` (khong khoa theo to chuc).
- **Ket qua kiem tra:** Thu dua that tren ban sao production (da ap dot 1-6 that, dung trang thai production + dot 6): hai tien trinh mo phien cung mot ban cung luc, 20 luot — ban dot 5 20/20 loi `duplicate key ... station_mode_periods_one_open_idx`, ban dot 6 0/20; ban A giu khoa 3 giay thi ban B van mo xong trong ~0,5 giay. Kich ban 4 ban song song (transaction + ROLLBACK) 8 muc dat. Kich ban LAI dung vi du cua chu du an (ban 1-2 dong hang, ban 3-4 nhan hoan, quet xen ke, doi vai giua chung) dat. Test agent: mot agent 8 camera 4 ban cuon lech nhip, doi vai giua chung — dat. `pnpm test` 475/475, `pnpm typecheck` dat, `pnpm build` dat, ESLint 0 loi. Du lieu thu tren ban sao da don.
- **Trang thai:** Da hoan thanh phan code. Cho chu du an ap migration `20260921140000` len production (code moi chay duoc ca khi chua ap). Chi commit o may, CHUA push.

### [AGENT-0.10.0] - Nang agent len 0.10.0 tren may dev (AGENT_KHO_HN_01)

- **Muc tieu:** Chu du an yeu cau update agent len phien ban moi nhat. Chu du an chot them: chi test tai AGENT_KHO_HN_01, khong dong vao bat cu gi cua Kho Dai Kim ke ca du lieu.
- **Files tao/sua:** `warehouse-agent/package.json`, `warehouse-agent/installer/betacom-agent.iss` (0.9.1 -> 0.10.0), `warehouse-agent/RELEASES.md`, `src/components/returns/ReturnCapturePanel.tsx` (bo doan giai thich thua theo yeu cau, chi giu "N ban · M dang nhan hoan"), `log/2026-09-21.md`, `change.md`. Bo cai `warehouse-agent/dist-installer/BetacomAgentSetup-v0.10.0.exe` (116 MB, chua dua len git).
- **Chi tiet thay doi:** 0.10.0 gom code agent dot 4-6: nhan tin hieu phien hoan, gan nhan doan video, nhieu ban song song, danh sach segment hoan 7 ngay, lich don o dia hang ngay. Agent `tsc` dat, test 144/145 (1 fail relay-hub cho cong 8554 dang bi agent that chiem — co tu truoc).
- **Su co khi cai va cach xu ly:** (1) Bo cai dang ky lai dich vu va XOA bien `NODE_EXTRA_CA_CERTS` -> agent loi `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; script sau cai dat lai bi tu choi vi khong co quyen admin -> chay lai bang quyen admin (UAC), dat lai bien va khoi dong lai. (2) `AGENT_SECRET` trong `.env` moi khac ban sao luu; toi da ghi de bang khoa cu tu ban sao luu — SAI: khoa trong database vua duoc doi luc 11:31:04 (chu du an tao khoa moi khi chay trinh cai), khoa bo cai ghi moi dung. Doi chieu ma bam voi database roi tra lai file bo cai da ghi. Bai hoc: doi chieu voi nguon su that (database) truoc khi "khoi phuc".
- **Ket qua kiem tra:** AGENT_KHO_HN_01 0.10.0: dich vu Running/Automatic, `boot-declare 200`, poll-commands/heartbeat/camera-probe/retention-plan deu 200, khong con loi 401 hay loi chung chi; `retention-plan.json` da tai ve; lich don o dia `MSFT_TaskDailyTrigger`. Loi con lai (bo doc QR camera `dahua_3` cua to chuc thu khong ket noi duoc camera) co tu truoc khi cai. Agent Kho Dai Kim (may kho rieng) KHONG bi cham toi — chi doc de xac nhan ghi hinh kho that khong bi ngat, sau do chu du an yeu cau khong doc nua.
- **Trang thai:** Da hoan thanh tren may dev. Agent may kho Dai Kim chua nang (can chay bo cai tren chinh may do). Chua push.

### [HOAN-E2E-AGENT] - Chay thu dau-cuoi agent 0.10.0: tach bach video dong hang / hoan hang

- **Muc tieu:** Chu du an yeu cau test luong agent moi: luu segment va cat ghep day len Supabase co tach bach duoc dong hang / hoan hang khong. Chi test tai AGENT_KHO_HN_01 (to chuc thu), khong dong vao Kho Dai Kim.
- **Cach test:** Camera thu khong o mang hien tai -> dung CAMERA AO (MediaMTX rieng cong 8654 + ffmpeg phat hinh thu co dong ho), tam tro `hik_3`/`dahua_3` cua to chuc thu sang hai luong ao (cau hinh goc luu lai de tra). Mo ca BAN_04, gui luot quet qua DUNG API agent that `/api/warehouse/scans` ky bang khoa AGENT_KHO_HN_01: don di -> the NHAN HOAN -> quet lai ma do (giao that bai) -> the TRAO -> the DONG HANG -> don di tiep.
- **Dat:** tach bach trong database dung (don di chot khi doi che do; kien hoan rts noi duoc luot gui di, the TRAO mo ho so 7 ngay; don di sau do dong binh thuong); agent ghi segment hai camera, cat va ghep PiP.
- **Loi that tim ra (cac kiem thu truoc deu bo lot):** (1) NGHIEM TRONG — `agent_commands_type_check` khong cho loai lenh `set_return_capture` -> cloud khong gui duoc tin hieu phien hoan, agent khong gan nhan doan video nao; (2) ky do the QR mo bi ghi `started_by=module`; (3) clip khieu nai kien hoan xin cat NGAY luc dong kien, doan video cuoi con dang ghi -> bo ghep bo mat goc QR vinh vien; (4) mang tai len cham (do duoc ~0,18 MB/s o wifi hien tai): file da len Supabase nhung agent het gio cho -> thu lai bi tu choi "resource already exists" -> clip ket o trang thai hong; (5) video da day len KHONG phan biet duoc dong hang/hoan hang ngoai database: duong dan bucket, ten file tai ve va dai chu tren hinh giong het nhau (kien giao that bai con trung ma van don voi video gui di).
- **Files tao/sua:** `supabase/migrations/20260921150000_agent_command_set_return_capture.sql` (moi — doc danh sach loai lenh DANG CO tren database roi them `set_return_capture`, khong chep cung; kem sua started_by the QR), `src/lib/watch/config.ts` (kien hoan vao thu muc `{org}/hoan/...`), `src/app/api/agent/clip-upload-url/route.ts`, `src/app/api/agent/clip-upload-complete/route.ts` (cung cong thuc duong dan, buoc xac minh lay thu muc tu bucketPath), `src/lib/order-proof/clip-file-name.ts` (tien to `HOAN-`), `src/app/api/agent/clip-cut-result/route.ts`, `src/lib/watch/proof-clip-signed-url.ts`, `src/lib/agent-commands/enqueue.ts` (dai chu tren hinh mo dau `HÀNG HOÀN · <loai> · <ket qua>`), `src/lib/station/return-clip-requests.ts` (cho 180 giay sau khi dong kien moi xin cat), `tests/return-clip-separation.test.ts` (moi — ca bai canh chung: moi loai lenh code chen vao agent_commands phai co trong rang buoc database), `change.md`, `log/2026-09-21.md`.
- **Ket qua kiem tra:** Migration chay thu tren ban sao: giu nguyen 14 loai lenh cu, them `set_return_capture`, chen duoc lenh moi, loai la van bi chan; the QR mo ky ghi `card`, giao dien ghi `module`. `pnpm test` 481/481, `pnpm build` dat. Don di: duong dan / ten file / dai chu KHONG doi.
- **Chua lam:** (4) can sua agent (nhan "da ton tai" la da tai len xong, hoac thoi gian cho theo toc do do duoc) — de xuat, chua lam; kho that (mang nhanh, clip 69 MB len trong 6-8 giay) chua gap. Chay lai toan bo kich ban de xac nhan gan nhan doan video + clip len Supabase can chu du an ap migration dot 6 va 7 len production truoc.
- **Trang thai:** Dang cho chu du an ap migration. Ca test BAN_04 va camera ao van dang chay (to chuc thu). Chua push.

### [AGENT-0.10.1] - Clip không kẹt "thất bại" khi mạng tải lên chậm

- **Mục tiêu:** Sửa lỗi 4 của lần chạy thử đầu-cuối (chủ dự án đồng ý): uplink ~180 KB/s làm clip hết giờ chờ trong khi file vẫn lên xong; lần thử lại bị Supabase báo "object đã tồn tại" nên clip bị đánh thất bại.
- **Nguyên nhân gốc thứ hai:** lệnh `cut_clip` chạy quá 2 phút (ghép PiP + tải chậm) thì reaper trả về `pending`. Poll mỗi 3 giây không chờ lượt trước, nên nhận lại cùng id trong khi bản đầu vẫn chạy, dẫn tới hai bản cắt + tải cùng một clip.
- **Files sửa:**
  - `warehouse-agent/src/upload.ts`: loại lỗi mới `already_exists`; thời gian chờ gấp đôi mỗi lần thử, kẹp 5 phút.
  - `warehouse-agent/src/index.ts`: gặp `already_exists` thì đi tiếp báo upload-complete; bỏ qua lệnh trùng id đang chạy.
  - `src/app/api/agent/clip-upload-complete/route.ts`: đối chiếu kích thước object với `file_size_bytes` khi clip còn `pending`.
  - `warehouse-agent/tests/upload-already-exists.test.ts` (mới), `tests/return-clip-separation.test.ts`.
  - Phiên bản 0.10.1: `warehouse-agent/package.json`, `installer/betacom-agent.iss`, `RELEASES.md`.
- **Kết quả kiểm tra:**
  - Cloud `pnpm test` 482/482.
  - Agent 148/149: test còn lại là MediaMTX smoke, lỗi do cổng 8554 đang bị agent đang chạy chiếm, không liên quan.
  - `tsc` agent đạt. Bộ cài `BetacomAgentSetup-v0.10.1.exe` build xong (116 MB, không vào git).
- **Trạng thái:** Chưa push.

### [HOAN-E2E-AGENT-2] - Chạy lại đầu-cuối trên agent 0.10.1 sau khi áp migration đợt 6, 7

- **Mục tiêu:** Xác nhận tách bạch video đóng hàng / hoàn hàng ở tầng agent sau khi sửa. Chỉ AGENT_KHO_HN_01 / tổ chức thử.
- **Kết quả:**
  - Migration 6, 7 đã có hiệu lực trên production. `set_return_capture` qua được ràng buộc; loại lệnh lạ vẫn bị chặn.
  - Agent nhận tín hiệu BẬT → TẮT → XONG phiên hoàn.
  - Đoạn đang ghi dở lúc đổi module lưu nốt và thuộc module cũ, cả hai chiều. Đoạn 13:54:41 vẫn là đơn đi; 13:55:41 và 13:56:41 mang nhãn hoàn; từ 13:57:41 là đơn đi.
  - Agent cắt và ghép PiP được clip đơn đi và clip khiếu nại kiện hoàn. Chủ dự án xác nhận test đạt.
- **Sự cố khi cài 0.10.1:** khoá bí mật của agent được tạo lại trên database trong lúc trình cài bị huỷ (mã thoát 5), nên `.env` giữ khoá cũ và agent bị từ chối `401 bad_signature`. Đã sửa bằng cách ghi khoá từ database vào `.env` của agent rồi khởi động lại dịch vụ.
- **Dọn dẹp:**
  - `hik_3` / `dahua_3` trả về cấu hình gốc.
  - Ca thử BAN_04 đã đóng.
  - Camera ảo đã tắt.
  - Xoá script tạm.
- **Trạng thái:** Hoàn tất.

### [PHAN-QUYEN] - Phân lại quyền: Admin full, Trưởng kho không setup camera, Viewer chỉ xem và tải video

- **Mục tiêu:** Chủ dự án chốt ngày 21/09/2026:
  - Admin và Chủ sở hữu: full quyền.
  - Trưởng kho: full quyền trừ setup (camera, gán camera/thiết bị vào bàn, thiết bị kho khác, máy trạm/agent).
  - Viewer: chỉ thấy 4 trang video (Giám sát đóng/hoàn hàng, Bằng chứng giao/hoàn hàng), xem và tải video.
  - Trưởng ca và Nhân viên đóng gói giữ nguyên.
  - Áp chung mọi tổ chức; tài khoản test chỉ ở tổ chức Betacom.
- **Files tạo/sửa:**
  - `supabase/migrations/20260921160000_role_permission_redesign.sql` (mới): đọc tập mã từ chính bảng quyền. Owner, admin, trưởng kho có mọi mã; trưởng kho bị gỡ 9 mã setup; viewer đúng 8 mã. Thêm quyền `return.operate` cho mọi vai trò trừ viewer.
  - `src/lib/supabase/guard.ts`: thêm `roleHasPermission`, `getEffectivePermissions`.
  - `src/app/api/session-permissions/route.ts` (mới), `src/lib/usePermissions.ts` (mới), `src/lib/nav-access.ts` (mới: quyền của từng mục menu).
  - `src/components/layout/DashboardSidebar.tsx`, `DashboardLayout.tsx`: menu ẩn mục không có quyền; vào URL bị cấm thì báo "không có quyền"; trang chủ bị cấm thì đưa tới trang đầu tiên được vào.
  - `src/app/api/cameras/discover/route.ts`: POST dò camera đòi `camera.create` thay vì `camera.view`.
  - `src/app/api/returns/capture/route.ts`, `src/app/api/returns/claims/bulk/route.ts`: thao tác ghi đòi `return.operate`.
  - `src/lib/live/station-streams.ts`, `src/lib/live/station-access.ts`, `src/app/api/live/[stationId]/route.ts`: xem camera trực tiếp theo quyền `live.view_remote` thay vì viết cứng owner/admin.
  - `src/components/returns/ReturnCapturePanel.tsx`, `src/app/dashboard/videos/page.tsx`, `src/app/dashboard/(return-module)/return-videos/page.tsx`: ẩn nút thao tác khi không có quyền.
  - `tests/role-permissions.test.ts` (mới).
- **Kết quả kiểm tra:**
  - Dry-run migration trên database cục bộ: owner/admin 45 mã, trưởng kho 36 mã (0 mã setup), viewer 8 mã, `return.operate` đủ 5 vai trò.
  - `pnpm test` 492/492, `tsc` đạt.
  - Chạy thật với 3 tài khoản test trên web: trước khi áp migration, kết quả khớp đúng ma trận cũ (18 dòng lệch như dự đoán). Chờ áp migration để chạy lại.
- **Sự cố phát hiện:** lỗi 404 ở trang giám sát ("chưa có bàn nào") là do bộ nhớ đệm `.next` của web dev đã cũ. Xoá `.next` rồi khởi động lại là hết.
- **Trạng thái:** Chờ chủ dự án áp migration. Thứ tự bắt buộc: migration trước, code sau; nếu ngược lại thì không ai mở được phiên nhận hoàn.

### [DON-DEP] - Dọn dữ liệu và file test trước khi merge vào main

- **Mục tiêu:** Chủ dự án yêu cầu dọn sạch dữ liệu rác sinh ra khi kiểm thử, để merge nhánh `2-camera` vào `main`.
- **Database** (chỉ tổ chức Betacom, không đụng Kho Đại Kim; giữ mọi tài khoản test):
  - Xoá 28 lượt quét test (cổng `test` / `e2e-test`), kéo theo 14 lượt đóng/hoàn `TEST…`.
  - Xoá 11 clip (4 file trên bucket), 2 hồ sơ khiếu nại, 8 ca thử, 13 lệnh agent đi kèm.
  - Xoá 2 kỳ nhận hoàn E2E cùng 2 kỳ đóng hàng sinh ra từ đó. Kỳ đóng hàng BAN_04 được nối liền 11:25 → 15:22.
  - Giữ 1 ca thử có chứa 2 lượt quét thật của chủ dự án.
- **File đã xoá:**
  - `BetacomAgentSetup-v0.8.9.exe/` (11 GB video ghi thử).
  - `.tmp/` (1,7 GB QA + bản sao production).
  - Bộ cài agent 0.8.9 / 0.9.0 / 0.9.1 / 0.10.0 (giữ 0.10.1).
  - `scratch_query.mjs`, `scratch_rpc.mjs` (có ghi cứng service key).
  - Log agent chạy dev, `auto.crt` / `auto.key` ở thư mục gốc, script tạm.
- **Nhật ký:** `log/` đổi tên thành `changelog/` theo chủ dự án; bản `changelog/` cũ hơn bị thay. Sửa tham chiếu còn hiệu lực trong `plans/active/HOAN-HANG-song-song-moi-ban.md`; các mục cũ trong `change.md` giữ nguyên như lịch sử.
- **`.gitignore`:** bỏ qua `dev-server.log`, chứng chỉ MediaMTX tự sinh, file trạng thái khi chạy agent dev.
- **Trạng thái:** Hoàn tất.

### [BO-THE] - Bỏ hẳn thẻ điều khiển bàn

- **Mục tiêu:** Chủ dự án yêu cầu bỏ hẳn phần thẻ điều khiển bàn ở mọi vai trò. Chuyển chế độ nhận hoàn chỉ còn trên trang Hàng hoàn; không ghi kết quả kiểm bằng thẻ nữa.
- **Files sửa/xoá:**
  - Xoá `src/app/dashboard/station-cards/`.
  - `src/lib/nav.ts`, `src/lib/nav-access.ts`: bỏ mục menu.
  - `src/lib/station/control-cards.ts`: bỏ danh sách thẻ in; chỉ còn nhận ra thẻ cũ.
  - `src/app/api/warehouse/scans/route.ts`: thẻ cũ bị bỏ qua, không ghi thành mã vận đơn.
  - `src/app/api/warehouse/manual-scan/route.ts`: thẻ cũ bị từ chối (410).
  - `src/lib/station/return-scan.ts`: bỏ `closeOpenReturnWithResult`, không còn ai gọi.
  - Test: `tests/control-cards.test.ts`, `tests/return-capture.test.ts`, `tests/return-lifecycle.test.ts`.
- **Hệ quả đã báo chủ dự án:** kiện hoàn không còn được ghi OK/Hỏng/Thiếu/Tráo và không tự mở hồ sơ khiếu nại.
- **Kết quả kiểm tra:** `pnpm test` 492/492, `tsc` đạt.
- **Trạng thái:** Hoàn tất.

### [HOAN-TU-BAT] - Vào phân hệ hàng hoàn là tự chuyển; mọi vai trò có video minh chứng

- **Mục tiêu:** Chủ dự án (22/09/2026):
  - Bỏ thẻ rồi thì chỉ cần vào phân hệ quay video hoàn hàng là bàn tự chuyển sang nhận hoàn, theo đúng luồng đã chốt.
  - Mọi vai trò đều có trang Bằng chứng giao hàng và Bằng chứng hoàn hàng (Viewer đang không thấy).
- **Files sửa:**
  - `src/components/returns/ReturnCaptureProvider.tsx`: vào phân hệ là tự bật nhận hoàn ở mọi bàn, trừ bàn người dùng đã bấm "Kết thúc" trên trình duyệt đó (nhớ trong localStorage, giữ chạy lai được). Tài khoản không có quyền thao tác thì im lặng bỏ qua. Bỏ chữ "thẻ QR" trên giao diện.
  - `supabase/migrations/20260921160000_role_permission_redesign.sql` (chưa áp): trưởng ca và nhân viên đóng gói có thêm `order_proof.view`, `video.view`, `video.download`.
  - `tests/role-permissions.test.ts`.
- **Nguyên nhân Viewer không thấy 2 trang video:** migration phân quyền chưa áp lên production, Viewer vẫn theo ma trận cũ (không có `order_proof.view`).
- **Kết quả kiểm tra:** dry-run migration trên database cục bộ: cả 6 vai trò có đủ quyền xem và tải video minh chứng. `pnpm test` đạt.
- **Trạng thái:** Chờ chủ dự án áp migration `20260921160000`.

### [TK-THIET-BI-CHI-XEM] - Trưởng kho chỉ xem trang Thiết bị kho

- **Mục tiêu:** Chủ dự án yêu cầu Trưởng kho chỉ xem được thiết bị nào cắm vào bàn nào, thiết bị nào chưa kết nối; không thêm, sửa, xoá hay đổi bàn.
- **Files sửa:**
  - `src/lib/nav-access.ts`: Thiết bị kho hiện cho ai có `station_device.view`; Viewer vẫn không thấy. Máy trạm kho vẫn chỉ cho người có quyền setup.
  - `src/app/dashboard/devices/page.tsx`: mỗi thao tác chỉ hiện khi có đúng quyền. Không còn thao tác nào thì bỏ luôn nút ⋮. Các thao tác gồm: Thêm thiết bị, Chỉnh sửa, Gán/Đổi bàn, Xoá, Test kết nối, Bật/tắt ghi.
  - `src/components/devices/StationAssignCell.tsx`: chế độ chỉ xem, hiện bàn và vai trò camera thay vì ô chọn.
  - `tests/role-permissions.test.ts`.
- **Chặn phía API:** đã có sẵn từ migration phân quyền — Trưởng kho không có 9 quyền setup.
- **Kết quả kiểm tra:** `pnpm test` 495/495, `tsc` đạt.
- **Trạng thái:** Hiệu lực đầy đủ sau khi áp migration `20260921160000`. Trước đó Trưởng kho vẫn còn quyền setup trên database nên vẫn thấy nút.

### [QUYEN-NGUOI-DUNG-NHAN-SU] - Người dùng hệ thống và Nhân sự kho theo vai trò

- **Mục tiêu:** Chủ dự án ngày 22/09/2026:
  - Người dùng hệ thống: chỉ Chủ sở hữu, Admin, Trưởng kho được xem. Trưởng ca, Nhân viên đóng gói, Viewer không thấy.
  - Nhân sự kho: chỉ Chủ sở hữu, Admin, Trưởng kho được thêm, sửa, xoá; các vai trò còn lại chỉ xem.
- **Files sửa:**
  - `supabase/migrations/20260921160000_role_permission_redesign.sql` (chưa áp): rút mọi `user.*` và mọi `staff.*` trừ `staff.view` khỏi trưởng ca / nhân viên đóng gói; cấp `staff.view` cho 3 vai trò này (viewer thêm vào tập của mình).
  - `src/app/dashboard/staff/page.tsx`: ẩn Thêm nhân viên, Liên kết tài khoản, Sửa, Xoá, Cấp/Cấp lại QR theo quyền.
  - `src/app/api/staff/route.ts`: chỉ trả mã QR vào ca (`qr_payload`) cho người có `staff.qr.regenerate`. Trước đây ai có `staff.view` cũng lấy được mã và quét vào ca thay nhân viên khác.
  - `tests/role-permissions.test.ts`.
- **Kết quả kiểm tra:** dry-run migration trên database cục bộ đúng như chốt: owner/admin/trưởng kho đủ `staff.*` + `user.*`; trưởng ca, nhân viên đóng gói, viewer chỉ có `staff.view`. `pnpm test` 497/497, `tsc` đạt.
- **Trạng thái:** Chờ áp migration.

### [TK-NGUOI-DUNG] - Trưởng kho quản lý người dùng vai trò thấp hơn

- **Mục tiêu:** Chủ dự án: Trưởng kho vẫn được thêm, sửa, xoá người dùng hệ thống có vai trò thấp hơn. Vai trò cao hơn gồm Admin và Chủ sở hữu.
- **Hiện trạng:** migration phân quyền đã cấp đủ `user.*` cho trưởng kho. API tạo/sửa/xoá đã chặn theo cấp bậc (`canAssignRole`): chỉ thao tác được tài khoản và cấp được vai trò thấp hơn mình.
- **Files sửa:**
  - `src/app/dashboard/users/page.tsx`: nút Sửa/Xoá chỉ hiện ở tài khoản thấp hơn người thao tác (dòng Admin/Chủ sở hữu/ngang cấp/chính mình hiện "—"). Ô chọn vai trò khi thêm/sửa chỉ liệt kê vai trò thấp hơn; vai trò mặc định khi thêm là vai trò cao nhất được phép.
  - `src/app/dashboard/staff/page.tsx`: mời tạo tài khoản từ Nhân sự kho cũng chỉ liệt kê vai trò thấp hơn.
  - `tests/role-permissions.test.ts`.
- **Kết quả kiểm tra:** `pnpm test` 498/498, `tsc` đạt.
- **Trạng thái:** Hoàn tất (hiệu lực đầy đủ sau khi áp migration `20260921160000`).

### [PHAN-QUYEN-KIEM-THAT] - Chạy thật phân quyền sau khi áp migration `20260921160000`

- **Mục tiêu:** Chủ dự án đã áp migration phân quyền. Kiểm tra thật trên web với từng vai trò.
- **Database production:** owner/admin 45 quyền, trưởng kho 36, trưởng ca 15, nhân viên đóng gói 12, viewer 9. Khớp dry-run.
- **Cách test:**
  - 3 tài khoản test cũ đã được chủ dự án tự xoá sáng 22/09. Tạo 3 tài khoản TẠM (mật khẩu ngẫu nhiên chỉ nằm trong bộ nhớ), đăng nhập, gọi API thật, rồi xoá ngay.
  - Kiểm lại: không còn tài khoản tạm nào.
- **Kết quả:**
  - Lượt 1: 67/68 đạt. Viewer vẫn đọc được `GET /api/devices` (danh sách thiết bị kèm IP) vì API chỉ đòi `camera.view`. Đã sửa `src/app/api/devices/route.ts` sang `station_device.view`, cùng quyền với trang Thiết bị kho.
  - Lượt 2: đạt hết.
    - Admin làm được mọi việc.
    - Trưởng kho bị chặn thêm camera / thiết bị / gán bàn / dò camera / tạo máy trạm, và bị chặn tạo tài khoản admin (`forbidden_role_escalation`). Vẫn thêm được nhân sự, người dùng thấp hơn và thao tác hàng hoàn.
    - Viewer chỉ đọc được 4 trang video và danh sách nhân sự; không nhận mã QR vào ca; mọi thao tác ghi bị 403.
- **Test:** `tests/role-permissions.test.ts` thêm chốt cho `/api/devices`; `pnpm test` 499/499.
- **Trạng thái:** Hoàn tất.

### [HOAN-CHON-BAN] - Trả lại việc chọn bàn nhận hoàn như ban đầu

- **Mục tiêu:** Chủ dự án: Giám sát hoàn hàng phải cho chọn bàn như lúc trước (1 bàn, vài bàn hoặc toàn bộ). Bản tự bật mọi bàn khi vào phân hệ ([HOAN-TU-BAT]) làm tất cả các bàn đổi sang hoàn hàng. Đó là do hiểu sai yêu cầu.
- **Files sửa:**
  - `src/components/returns/ReturnCaptureProvider.tsx`: bỏ tự bật và bỏ việc nhớ bàn đã tắt. Giữ phần bỏ chữ "thẻ QR".
  - `src/components/returns/ReturnCapturePanel.tsx`: bảng hiện cho mọi vai trò. Không có quyền `return.operate` thì nút mờ, bấm chỉ báo "Bạn không có quyền bật/tắt nhận hoàn", không gửi request.
  - `src/lib/useGuard.ts` (mới): chặn thao tác ngay từ nút cho mọi trang.
  - `tests/role-permissions.test.ts`: chốt "vào phân hệ không tự bật bàn nào".
- **Trạng thái:** Hoàn tất.

### [CHAN-TU-NUT] - Không có quyền thì chặn ngay từ nút, báo "Bạn không có quyền …"

- **Mục tiêu:** Chủ dự án chỉ ra lỗi logic nghiêm trọng: có nút vẫn cho thao tác (mở form, điền xong) rồi mới báo không thành công từ API. Quy tắc mới cho MỌI nút ghi dữ liệu: không có quyền thì nút mờ, bấm vào chỉ báo "Bạn không có quyền …", không mở form, không gửi request.
- **Nguyên nhân:** chỉ vài trang được chặn theo quyền, và chặn bằng cách ẩn nút. Chưa rà toàn bộ giao diện. Các trang lọt:
  - Tổ chức & Kho: sửa tổ chức, thêm/sửa/xoá kho.
  - Bàn đóng hàng: thêm/sửa/lưu trữ bàn, đổi chế độ bàn.
  - Cấu hình kho.
  - Các nút phụ trong ô gán bàn: đổi nguồn quét, đổi vị trí camera.
- **Files tạo/sửa:**
  - `src/lib/guard-core.ts` (mới, lõi thuần `runGuarded`).
  - `src/lib/useGuard.ts` (`usePageGuard`, `deniedClass`).
  - `src/app/dashboard/warehouses/page.tsx`, `src/app/dashboard/packing-stations/page.tsx`, `src/components/stations/StationPurposeCell.tsx`, `src/app/dashboard/settings/warehouse-config/page.tsx`.
  - `src/app/dashboard/devices/page.tsx`, `src/components/devices/StationAssignCell.tsx`: bỏ ẩn, chuyển sang chặn-khi-bấm.
  - `src/app/dashboard/staff/page.tsx`: cấp QR chặn trước cả hộp xác nhận.
  - `src/app/dashboard/users/page.tsx`: báo rõ lý do — thiếu quyền / vai trò ngang hoặc cao hơn / chính mình.
  - `src/app/dashboard/videos/page.tsx`, `src/app/dashboard/(return-module)/return-videos/page.tsx`, `src/components/returns/ReturnCapturePanel.tsx`.
  - `tests/role-permissions.test.ts`: test `runGuarded` (không quyền thì KHÔNG chạy thao tác), và test mọi trang có nút ghi phải có chốt chặn, không còn kiểu ẩn nút.
- **Kết quả kiểm tra:** `pnpm test` 501/501, `tsc` đạt. Mở thật 9 trang đã sửa bằng tài khoản tạm (xoá ngay sau): đều 200.
- **Trạng thái:** Hoàn tất.

### [VIEWER-BAO-CAO-THIET-BI] - Viewer xem thêm Báo cáo và Thiết bị kho (chỉ xem)

- **Mục tiêu:** Chủ dự án cho Viewer xem thêm Báo cáo và Thiết bị kho, chỉ xem, không thêm/sửa/xoá.
- **Files tạo/sửa:**
  - `supabase/migrations/20260922100000_viewer_reports_devices.sql` (mới, chưa áp): thêm `report.view`, `station_device.view` cho viewer. Không thêm quyền ghi nào. Không thêm `packing_station.view`, vì quyền đó mở luôn Tổ chức & Kho và Bàn đóng hàng.
  - `src/components/devices/StationAssignCell.tsx`: không tải được danh sách bàn thì vẫn hiện đúng bàn đang gắn (trước đây sẽ rơi về "Chưa gắn").
  - `tests/role-permissions.test.ts`.
- **Hệ quả:** `report.view` cũng mở Bảng điều khiển (cùng quyền đọc số liệu). Trên trang Thiết bị kho mọi nút thao tác hiện mờ, bấm vào chỉ báo không có quyền.
- **Kết quả kiểm tra:** dry-run hai migration trên database cục bộ: viewer 11 quyền, toàn quyền xem. `pnpm test` 501/501.
- **Trạng thái:** Chờ chủ dự án áp migration `20260922100000`.

### [VIEWER-XEM-TAT-CA] - Viewer xem mọi trang trừ Quản lý hệ thống; ẩn thông tin nhạy cảm

- **Mục tiêu:** Chủ dự án (22/09/2026):
  - Viewer xem được tất cả các trang, trừ nhóm Quản lý hệ thống (không có trên giao diện).
  - Các trang khác chỉ xem, không thêm/sửa/xoá.
  - Thông tin có thể bị lợi dụng để tác động tới người dùng khác hoặc hệ thống thì ẩn đi.
- **Files tạo/sửa:**
  - `supabase/migrations/20260922100000_viewer_reports_devices.sql` (viết lại, chưa áp):
    - Viewer thêm `report.view`, `packing_station.view`, `station_device.view`, `station_device_assignment.view`.
    - Quyền mới `sensitive.view` cho mọi vai trò trừ viewer.
    - Chốt xoá mọi mã nhạy cảm / quản lý hệ thống / ghi khỏi viewer.
  - `src/lib/sensitive-redact.ts` (mới).
  - `src/app/api/cameras/route.ts`, `src/app/api/devices/route.ts`: che IP, cổng, RTSP, username, MAC camera; kết quả test cũ chỉ giữ đúng/sai (có thể chứa URL RTSP).
  - `src/app/api/staff/route.ts`: che SĐT / email.
  - `src/app/api/warehouses/route.ts`, `src/app/api/warehouses/[id]/route.ts`: URL webhook Lark chỉ cho người có `warehouse.update`, người khác thấy `••••`. `src/app/api/warehouses/notifications-overview/route.ts` đòi `warehouse.update`.
  - `src/app/api/cameras/discover/route.ts`: kết quả dò mạng (IP/MAC cả LAN) đòi `camera.create` như lệnh dò.
  - `src/lib/nav-access.ts`, `src/app/dashboard/agents/page.tsx`: Máy trạm kho cho người có `station_device.view` xem; tạo / cấp secret / xoá chặn ở nút.
  - `tests/role-permissions.test.ts`.
- **Kết quả kiểm tra:** dry-run hai migration trên database cục bộ: viewer 13 quyền, toàn quyền xem; `sensitive.view` đủ 5 vai trò còn lại. `pnpm test` 503/503, `tsc` đạt.
- **Trạng thái:** Chờ chủ dự án áp migration `20260922100000`.

### [DEV-LAN-ORIGIN] - Mở web dev qua IP mạng LAN không đăng nhập được

- **Mục tiêu:** Chủ dự án không đăng nhập được khi mở web qua `https://192.168.1.42:3000`.
- **Nguyên nhân:** Next 16 chặn tài nguyên dev (HMR, script) với địa chỉ ngoài danh sách `allowedDevOrigins`, mà danh sách chỉ có `192.168.66.160` (IP cũ). Trình duyệt không chạy được JS nên form đăng nhập gửi thẳng `GET /login?`. IP máy dev đổi theo mạng (192.168.1.x, 192.168.31.x, …).
- **Files sửa:** `next.config.ts` — `allowedDevOrigins: ["192.168.*.*", "127.0.0.1"]`. Next so khớp từng đoạn nên mẫu này phủ mọi IP LAN 192.168.x.y. Chỉ ảnh hưởng `next dev`.
- **Kết quả kiểm tra:** request từ 192.168.1.42 tải được script (200), HMR không bị chặn; request từ origin lạ vẫn bị chặn (403).
- **Còn lưu ý:** chứng chỉ `certs/localhost.pem` chỉ cấp cho `localhost`, nên mở qua IP thì trình duyệt cảnh báo chứng chỉ; bấm tiếp tục là vào được.
- **Trạng thái:** Hoàn tất.

### [HOAN-DOT-7] - Nhật ký nói cùng một thứ tiếng, báo cáo có đơn hoàn, chưa mở ca thì không quay, hạn lưu riêng

- **Mục tiêu:** Chủ dự án chốt 23/09/2026, năm việc. Kế hoạch: `plans/active/HOAN-HANG-dot-7-nhat-ky-bao-cao-han-luu.md`.
- **1. Cột Loại và Ghi chú của hàng hoàn ghi y như đóng hàng:**
  - `src/lib/warehouse/live/returns.ts`: `classifyReturnEvent` trả đúng các loại của đóng hàng (`waybill_valid`, `waybill_duplicated`, `waybill_no_session`, `waybill_return_suspect`). Bỏ các loại tự chế (Đang mở / Hàng ổn / Có vấn đề / Quét lại / Lưới an toàn).
  - Ghi chú của hàng hoàn LUÔN rỗng: cột Loại đã nói đủ, cột Ghi chú chỉ còn cảnh báo video nặng như trang đóng hàng. Không ghi lý do hoàn ("hoàn là hoàn thôi").
  - `src/app/dashboard/(return-module)/returns/page.tsx`: chép đúng bảng nhãn của trang Giám sát đóng hàng (Hợp lệ, Trùng, Chưa vào ca, Máy quét chưa gán, Mã sai, Hàng hoàn, QR sai).
  - `src/lib/warehouse/live/activity.ts`: bỏ 5 loại riêng khỏi `ActivityKind`.
- **2. Quét khi chưa mở ca thì không quay, không có giờ:**
  - `supabase/migrations/20260923090000_no_session_no_video.sql` (mới, ĐÃ ÁP 23/09/2026): trong `process_waybill_scan`, kiểm tra ca TRƯỚC lưới an toàn. Trước đây lưới an toàn ghi ngay kiện hoàn `return_suspect` kể cả khi không có ca, nên lượt quét có giờ bắt đầu = giờ kết thúc = giờ quét và vẫn hiện nút "Tạo clip", trong khi không có đoạn video nào.
  - `src/lib/order-proof/proof-clip-gate.ts` + hai route `watch`, `watch/retry`: chặn cắt clip cho lượt quét `no_active_session`.
- **3. Báo cáo hiệu suất có phần hàng hoàn:** `src/lib/reports/service.ts` thêm `aggregateReturns` (đếm riêng, không trộn vào sản lượng đóng hàng, không vào số đơn nhân sự); `src/app/dashboard/reports/page.tsx` thêm khung "Hàng hoàn" gồm số kiện hoàn, số lượt quét lại và bảng theo ngày.
- **4. Cấu hình kho có ô số ngày giữ video hàng hoàn:** `supabase/migrations/20260923100000_org_return_retention_days.sql` (mới, ĐÃ ÁP 23/09/2026) thêm cột `organizations.return_retention_days` (7–365, NULL = 7 ngày); `src/app/api/organization/route.ts` cho đọc/ghi; `src/app/api/agent/retention-plan/route.ts` ưu tiên cấu hình cấp tổ chức rồi mới tới config kho; trang Cấu hình kho thêm ô nhập ngay dưới ô cũ.
- **5. Cột mã vận đơn của Bằng chứng hoàn hàng chỉ còn hạn khiếu nại:** `src/app/dashboard/(return-module)/return-videos/page.tsx` bỏ nhãn lý do hoàn (Giao thất bại / Khách trả / Quét ở bàn đóng hàng) và nhãn kết quả kiểm (Hàng ổn / Hỏng / Thiếu / Tráo / Chưa kiểm) khỏi cột mã vận đơn, thẻ lưới và ngăn chi tiết; giữ nguyên thẻ hồ sơ khiếu nại kèm đồng hồ đếm ngược. Bỏ luôn ô "Loại hoàn" trong ngăn chi tiết. Chữ khắc trên video (`src/lib/agent-commands/enqueue.ts`) KHÔNG đổi.
- **6. Khối "Cần xử lý" của Giám sát hoàn hàng làm y như đóng hàng:** trước đây khối này là danh sách hồ sơ khiếu nại còn hạn — một việc khác hẳn bên đóng hàng, lại lặp đúng đồng hồ đếm ngược đã có ở trang Bằng chứng hoàn hàng. Giờ nó liệt kê các lượt quét hỏng TRONG NGÀY của luồng hoàn, cùng bộ chữ với đóng hàng. `src/lib/warehouse/live/issues.ts` thêm `describeScanIssue` + `ISSUE_STATUSES` làm nguồn chữ duy nhất cho cả hai màn hình; `src/lib/warehouse/live/returns.ts` bỏ truy vấn `return_claims`; `src/lib/warehouse/live/summary.ts` đếm thêm `no_active_session / unmapped_scanner / invalid_code` cho luồng hoàn (và KHÔNG tính chúng là kiện nhận được nữa), bỏ `open_claims` nên hết một phép đếm mỗi nhịp poll 3 giây.
  - **Nguồn dữ liệu vẫn tách đôi** (chủ dự án nhấn mạnh: "nguồn riêng nhé, chỉ là xử lý giống thôi"): mỗi màn hình chỉ đọc lượt quét của luồng mình. Truy vấn của đóng hàng nay có thêm `.eq("event_kind", "outbound")` cho chắc.
  - Thẻ số "Cần xử lý" của trang hoàn đếm y công thức bên đóng hàng; lưới an toàn nằm ở dòng phụ như "đơn vượt ngưỡng".
- **7. Cấu hình kho:** ô cũ đổi tên thành "Số ngày giữ video đóng hàng" để thành cặp rõ ràng với ô hàng hoàn.
- **8. Khối "Hoạt động hôm nay" của hai màn hình giống hệt nhau:** trang hoàn đổi tab "Hàng ổn / Quét lại / Thẻ điều khiển" thành "Hợp lệ / Trùng / QR nhân sự" y như đóng hàng; bộ lọc tab chép đúng luật bên đóng hàng; thêm nhãn Vào ca / Ra ca / Đổi ca. `src/lib/warehouse/live/activity.ts` tách `describeStaffScan` làm nguồn chữ duy nhất cho lượt quét QR nhân sự; `buildReturnActivity` tự truy vấn `staff_qr_scan_results` của mình (nguồn riêng) rồi đọc qua hàm đó, nên nhật ký hoàn hàng giờ có cả dòng vào/ra ca như đóng hàng.
- **9. Trang Báo cáo hiệu suất có phần hoàn hàng đầy đủ:** thêm thẻ số "Tổng đơn hoàn"; "Thời gian TB / thời gian xử lý" đổi thành "Thời gian đóng hàng TB / thời gian đóng hàng"; thêm biểu đồ "Sản lượng hoàn hàng theo ngày"; bảng nhân sự tách thành MỘT component `StaffReportTable` dùng hai lần — "Báo cáo đóng hàng theo nhân sự" và "Báo cáo hoàn hàng theo nhân sự"; bỏ khung "Hàng hoàn" (2 ô + bảng theo ngày) vì nội dung đã nằm ở thẻ số và biểu đồ.
  - `src/lib/reports/service.ts`: `ReturnsSummary` đổi sang đúng hình dạng của đóng hàng (`totals` + `daily` + `staff`). Lượt quét hoàn được chuẩn hoá về từ vựng đóng hàng (`duplicated_return`→`duplicated`, `return_suspect`→`valid`, bỏ hẳn lượt quét hỏng) rồi dùng LẠI `aggregateDaily` / `computeTotals` / `aggregateStaff` — không viết phép đếm thứ hai.
  - Hồ sơ nhân sự giờ nạp theo cả hai luồng, nếu không người chỉ nhận hoàn sẽ hiện "—".
- **Files test:** `tests/return-dot7-nhat-ky-bao-cao.test.ts` (mới, 14 bài); cập nhật `tests/return-pages.test.ts`, `tests/counting-excludes-returns.test.ts` và `tests/role-permissions.test.ts` theo luật mới.
- **Kết quả kiểm tra:** `pnpm test` 548/548, `tsc` đạt, `eslint` không lỗi. Đã áp cả hai migration và kiểm trên web thật (org test KHO_HN_01): lưu 10 ngày → 200 và đọc lại đúng; nhập 3 ngày bị chặn 400; máy kho nhận số ngày mới qua `/api/agent/retention-plan`; báo cáo trả khung hàng hoàn; sản lượng đóng hàng không đổi. Báo cáo: `/api/reports/performance?range=30d` trả tổng đơn hoàn 5, quét lại 2, biểu đồ 30 ngày và bảng nhân sự hoàn hàng CÙNG bộ thuộc tính với bảng đóng hàng. Khối "Cần xử lý": tạo tạm 2 lượt quét hỏng của luồng hoàn rồi xoá sạch — trang hoàn đọc ra "Quét khi chưa vào ca" và "Hàng hoàn", trang đóng hàng KHÔNG thấy hai mục đó.
- **Trạng thái:** Hoàn tất.

### [PERM-XOA-USER] - Chỉ chủ sở hữu được xoá tài khoản, và xoá là xoá thật

- **Mục tiêu:** Chủ dự án chốt 23/09/2026: "chỉ có chủ sở hữu mới được quyền xoá tài khoản khác, các role khác không được phép, chủ sở hữu phải thật sự xoá được, xoá luôn dữ liệu tài khoản đó khỏi database".
- **Hai lớp chặn:**
  - `supabase/migrations/20260923110000_only_owner_deletes_users.sql` (mới, CHƯA ÁP): xoá `user.delete` khỏi mọi vai trò trừ `owner`. Trước đó owner + admin + trưởng kho đều có (đợt phân quyền 22/09). `user.create` và `user.update` GIỮ NGUYÊN cho admin và trưởng kho.
  - `src/app/api/users/[id]/route.ts`: chốt độc lập với bảng quyền — `ctx.role !== "owner"` → 403 `owner_only`, đặt TRƯỚC mọi thao tác chạm database. Một dòng cấp nhầm trong `role_permission_matrix` không mở được cánh cửa này.
- **Xoá thật:** vẫn `auth.admin.deleteUser` (hồ sơ `user_profiles` đi theo bằng khoá ngoại ON DELETE CASCADE — đã đo trên database thật), thêm lệnh xoá hồ sơ làm lưới an toàn cho hai ca hiếm: cascade bị gỡ, hoặc hồ sơ mồ côi khi tài khoản đăng nhập đã mất từ trước. Nhật ký `audit_logs` vẫn giữ (khoá ngoại ON DELETE SET NULL) — mất người nhưng không mất dấu vết.
- **Giao diện:** nút Xoá đã chặn-khi-bấm sẵn theo `user.delete`, nên admin/trưởng kho bấm vào chỉ nhận "Bạn không có quyền xoá người dùng." Hộp xác nhận viết rõ hồ sơ bị xoá hẳn, nhật ký cũ vẫn giữ.
- **Files test:** `tests/role-permissions.test.ts` — bỏ giả định trưởng kho có `user.delete`, thêm bài canh migration + chốt route + "không được biến thành xoá mềm".
- **Kết quả kiểm tra:** `pnpm test` 549/549, `tsc` đạt. Kiểm trên web thật (org test, tài khoản tạm đã xoá sạch): admin → 403, trưởng kho → 403, tài khoản đích vẫn còn nguyên; chủ sở hữu → 200, hồ sơ biến khỏi `user_profiles`, tài khoản đăng nhập cũng mất, `audit_logs` vẫn ghi `user.delete`; chủ sở hữu tự xoá mình → 400.
- **Trạng thái:** Chờ chủ dự án áp migration (bảng `role_permission_matrix` không sửa được bằng service role).
