# warehouse-agent/src

Folder nay la source TypeScript cua Warehouse Agent chay tren may tai kho.

Vai tro chinh:

- Doc scanner COM va gui scan raw len backend.
- Poll command tu backend va thuc thi cac lenh camera/recording/proof.
- Quan ly FFmpeg recording segment tren o cung local.
- Chay MediaMTX local relay de browser xem live qua WHEP.
- Decode QR tu camera QR khi station dung `scan_source = camera`.

Nhung diem da xu ly trong luong 2-camera:

- `camera-connect.ts`/`onvif-auth.ts` thu ket noi ONVIF/RTSP theo credential admin nhap tu UI.
- `recording.ts` spawn FFmpeg tao segment, redacted RTSP credential trong log.
- `live/relay-hub.ts` tao MediaMTX runtime config khong chua credential, credential chi nam trong env cua process con.
- `qr/*` lay frame tu stream QR va decode thanh scan event.
- `compose/clip-composer.ts` ghep overview + QR thanh clip proof cuoi cung.

Nguyen tac bao tri:

- Khong luu username/password camera ra file cau hinh agent.
- Khong tao installer moi neu chi sua logic runtime.
- Khi them lenh moi, cap nhat `commands.ts`, handler trong `index.ts`, test agent va API enqueue tu cloud.
