# src/app/api/packing-stations

Folder nay chua API quan ly ban dong goi va gan camera vao ban.

Endpoint lien quan 2-camera:

- `GET/POST /api/packing-stations`
- `GET/PATCH /api/packing-stations/[id]`
- `POST /api/packing-stations/[id]/cameras`

Nhung diem da xu ly trong luong 2-camera:

- Station co `scan_source` de chon nguon scan la scanner hoac camera.
- API gan camera phai gan dung station/agent va giu password camera theo luong ma hoa hien co.
- Khi gan QR camera, cac route lien quan station-device co the tao scanner ao `qrcam_<camera_code>`.

Nguyen tac bao tri:

- Khong gan cung mot thiet bi vat ly vao nhieu ban active neu khong co thao tac chuyen ban ro rang.
- Khong hardcode camera credential test vao route.
- Logic lien quan camera setup nen uu tien helper trong `src/lib/camera/station-setup.ts`.
