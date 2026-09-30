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
do, chi thu nho khi vuot tran `QR_FRAME_WIDTH`/`QR_FRAME_HEIGHT`. Mac dinh
doc luong GOC; `QR_STREAM=sub` de quay lai luong phu khi may kho yeu.

## Hai pha + ha tran — sua cham tu 30/09/2026

Ban 24/09 ghi "decode khong phai cho ton: 1920 mat 17ms, 2560 mat 31ms".
DO LAI cho thay con so do sai hon muoi lan. Khung TRONG (canh ~99% thoi
gian, va la khung DAT nhat vi khong co ma thi bo giai ma phai quet can anh
moi dam ket luan) mat 189ms o 2560x1440, trong khi ngan sach chi co 100ms
moi khung (10 khung/giay).

Hau qua: `decoderBusy` o `qr-scan-service.ts` vut 2 trong 3 khung, ma
`qr-zone.ts` lai doi HAI khung lien tiep cung doc ra mot ma moi phat luot
quet — nen nhan vien phai gio nhan dung yen cho. Dung trieu chung "quet
mai khong an".

Goc chi phi KHONG phai ma vach (2.3x) ma la co khung (15x) cong hai co
`tryHarder`/`tryDenoise` (moi co ~45% thoi gian). Hai viec da lam:

1. Ha tran 2560x1440 -> 1920x1080. Day la SAN: do o 1600x900 thi ma TikTok
   12mm mat luon, dung loi ma ban 24/09 sinh ra de sua.
2. Giai ma HAI PHA o `qr-decoder.ts`:
   - Pha nhanh: QR + DataMatrix + Code128, khong bat co nao (~12ms).
   - Pha ky: du 9 dinh dang, du bon co. CHI chay khi pha nhanh trang tay,
     va toi da 500ms mot lan cho MOI camera.

Ket qua do tren may ranh: 189ms -> 12ms moi khung o trang thai thuong truc.
Khong con vut khung, nen `confirmFrames = 2` dat duoc trong ~0.2s.

Vi sao van giu pha ky: ma nho/mo/nghieng can du co `try*` moi doc duoc.
Hoan toi 500ms khong lam mat ma — nhan nam truoc ong kinh lau hon nhieu so
voi con so do.

## Ma vach

Doc ca Code128 / Code39 / Code93 / ITF / Codabar / DataMatrix. KHONG doc
EAN/UPC: do la ma san pham, doc trung la tao don bang ma hang hoa.

Mot nhan van don thuong in 2-3 ma, nen `code-pick.ts` giu luat chon:

0. Duong link thi bo, bat ke QR hay ma vach (nhan TikTok in mot QR ma van
   don va mot QR link toi trang shop).
1. Ma vach phai "trong giong ma van don" moi duoc xet; QR khong loc.
2. KHONG uu tien QR hay ma vach. Noi dung xuat hien NHIEU LAN trong khung
   thi thang — tren nhan that, ma van don in lap lai con ma phan loai chi
   mot lan. Hoa so lan thi lay ma to nhat.
3. Chi coi la hai nhan trong khung (khong doan) khi hai noi dung khac nhau
   co CUNG so lan va to xap xi nhau (duoi 1,5 lan).

Nguyen tac bao tri:

- Khong spam backend cung mot ma lien tuc; giu debounce/dedup trong service.
- Khong luu frame co thong tin nhay cam neu khong co yeu cau debug ro.
- Doi chu / dinh dang doc duoc thi sua o `qr-decoder.ts` va `code-pick.ts`,
  dung rai luat chon ra nhieu noi.
