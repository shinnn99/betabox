# src/app/api/order-proof

Folder nay chua API cho man hinh va workflow video bang chung don hang.

Endpoint chinh:

- `GET /api/order-proof/scans`: danh sach scan/proof de dashboard hien thi.
- `POST /api/order-proof/[pe_id]/watch`: yeu cau xem/cat/ghep clip cho mot packing event.
- `POST /api/order-proof/[pe_id]/watch/retry`: thu lai khi clip loi.
- `GET /api/order-proof/clips/[clipId]`: lay thong tin/signed URL clip.

Nhung diem da xu ly trong luong 2-camera:

- Watch flow phai lay dung segment cua camera overview va QR, sau do enqueue len agent dang giu file local.
- Clip output duoc agent ghep theo bo cuc giong khung live station.
- Cac route clip-upload/clip-result o `src/app/api/agent` la nua con lai cua workflow nay.

Nguyen tac bao tri:

- Khong cat video tren cloud neu file segment nam tren may agent.
- Khong bo qua trang thai `progress_state`; UI va retry phu thuoc vao do de biet clip dang cat/ghep/upload.
- Khi sua cua so clip, cap nhat helper trong `src/lib/order-proof` truoc.
