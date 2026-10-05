# src/app/api/order-proof

Folder nay chua API cho man hinh va workflow video bang chung don hang.

Endpoint chinh:

- `GET /api/order-proof/scans`: danh sach scan/proof de dashboard hien thi.
- `POST /api/order-proof/[pe_id]/watch`: yeu cau xem/cat/ghep clip cho mot packing event.
- `POST /api/order-proof/[pe_id]/watch/retry`: thu lai khi clip loi.
- `GET /api/order-proof/clips/[clipId]`: **DEPRECATED 03/07/2026, dung cho
  caller moi.** Doc clip tu `clip_path` tren o dia agent — chi chay duoc khi
  server cung may agent, nen da chet san tu khi prod roi Vercel sang VPS.
  Duong dung bay gio: `signed_url` trong response cua `/watch` (mot cua,
  khong hai cho tra URL clip). Route con giu vi co the con deep-link cu
  trong email/bookmark; tu 02/10/2026 co `console.warn` moi luot goi de do
  xem con ai dung that khong — im lang 1-2 tuan thi xoa.

Nhung diem da xu ly trong luong 2-camera:

- Watch flow phai lay dung segment cua camera overview va QR, sau do enqueue len agent dang giu file local.
- Clip output duoc agent ghep theo bo cuc giong khung live station.
- Cac route clip-upload/clip-result o `src/app/api/agent` la nua con lai cua workflow nay.

Nguyen tac bao tri:

- Khong cat video tren cloud neu file segment nam tren may agent.
- Khong bo qua trang thai `progress_state`; UI va retry phu thuoc vao do de biet clip dang cat/ghep/upload.
- Khi sua cua so clip, cap nhat helper trong `src/lib/order-proof` truoc.
