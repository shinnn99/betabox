# warehouse-agent/src/qr

Folder nay chua pipeline doc QR tu camera.

Vai tro chinh:

- Lay frame tu stream camera QR.
- Gioi han vung doc QR neu co cau hinh zone.
- Decode QR bang ZXing wasm.
- Gui ket qua nhu mot scan event ve backend de giu kien truc scanner cu.

Nhung diem da xu ly trong luong 2-camera:

- Camera QR duoc coi nhu scanner ao `qrcam_<camera_code>`.
- QR decode chi nen tao don khi station dang cau hinh `scan_source = camera`.

Nguyen tac bao tri:

- Khong spam backend cung mot QR lien tuc; giu debounce/dedup trong service.
- Khong luu frame co thong tin nhay cam neu khong co yeu cau debug ro.
- Neu camera/main stream nang, uu tien substream cho decode QR.
