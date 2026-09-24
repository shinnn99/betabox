# warehouse-agent/src/qr

Folder nay chua pipeline doc ma tu camera (QR va ma vach).

Vai tro chinh:

- Lay frame tu stream camera QR (`qr-frame-source.ts`).
- Chon mot ma trong so cac ma nhin thay (`code-pick.ts`).
- Khu trung / xac nhan qua nhieu khung (`qr-zone.ts`).
- Decode bang ZXing wasm (`qr-decoder.ts`).
- Gui ket qua nhu mot scan event ve backend de giu kien truc scanner cu.

Nhung diem da xu ly trong luong 2-camera:

- Camera QR duoc coi nhu scanner ao `qrcam_<camera_code>`.
- QR decode chi nen tao don khi station dang cau hinh `scan_source = camera`.

## Do phan giai — cho hong tu 24/09/2026

Truoc do frame bi ep cung 640x360 truoc khi decode. Camera 2K hay 4K cung
nhu nhau, nen ma QR nho (nhan TikTok) mat het chi tiet NGAY TAI AGENT.

Gio agent do do phan giai that cua luong bang ffprobe roi decode o dung co
do, chi thu nho khi vuot tran `QR_FRAME_WIDTH`/`QR_FRAME_HEIGHT` (mac dinh
2560x1440). Decode khong phai cho ton: 1920x1080 mat 17ms, 2560x1440 mat
31ms moi khung. Mac dinh doc luong GOC; `QR_STREAM=sub` de quay lai luong
phu khi may kho yeu.

## Ma vach

Doc ca Code128 / Code39 / Code93 / ITF / Codabar / DataMatrix. KHONG doc
EAN/UPC: do la ma san pham, doc trung la tao don bang ma hang hoa.

Mot nhan van don thuong in 2-3 ma, nen `code-pick.ts` giu luat chon:

1. Co QR thi QR thang (duong dang chay tot cho nhan thuong).
2. Khong co QR thi lay ma vach TO NHAT, va phai to hon ma ke tiep 1,5 lan.
   Hai ma to ngang nhau = dau hieu hai nhan trong khung, agent khong doan.
3. Ma ngan kieu ma tuyen ("HN01") bi loai truoc khi xet.

Nguyen tac bao tri:

- Khong spam backend cung mot ma lien tuc; giu debounce/dedup trong service.
- Khong luu frame co thong tin nhay cam neu khong co yeu cau debug ro.
- Doi chu / dinh dang doc duoc thi sua o `qr-decoder.ts` va `code-pick.ts`,
  dung rai luat chon ra nhieu noi.
