# supabase/migrations

Folder nay chua migration SQL cho Supabase/PostgreSQL.

Nhung migration lien quan luong 2-camera:

- `*_two_cameras_base_schema.sql`: them station/agent/camera fields, command types va permission.
- `*_two_cameras_logic_schema.sql`: du kien them proof QR camera, metadata clip proof, request queue va trigger/RPC lien quan recording theo ca.

Tinh trang can luu y:

- Migration base da duoc tao va test typecheck o cac task truoc.
- Migration logic can duoc doi chieu lai voi `docs/tuan-tu-xu-ly-2-camera.md` truoc khi apply production, vi audit truoc do da ghi nhan mot so diem chua production-ready.

Nguyen tac bao tri:

- Khong sua migration da apply neu moi truong production da chay; tao migration moi.
- Check constraint enum text phai duoc noi long theo cach idempotent.
- RLS/permission thay doi phai co ly do ro trong `change.md`.
