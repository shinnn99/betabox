# src/components/station

Folder nay chua component UI cho man hinh live cua tung ban dong goi.

Vai tro chinh:

- `StationLivePanel.tsx` goi API live theo station, poll event thanh cong/loi, hien toast, phat am bao va doc thong bao tieng Viet.
- `LiveLayout.tsx` ve bo cuc 2 camera: overview full frame, QR picture-in-picture.
- `WebRtcPlayer.tsx` mo WHEP session va render video tren browser.

Nhung diem da xu ly trong luong 2-camera:

- Khi chon mot ban tren dashboard, component mount live cua ban do; bam lai thi unmount viewer, khong dung recording tren agent.
- Bo cuc live phai giong bo cuc clip proof cuoi cung: overview 16:9, QR o goc tren phai.
- Fullscreen chi phong/thu phan khung live, khong lam thay doi stream dang chay.
- Thong bao co ba muc am: thanh cong 1 tieng cao, canh bao 2 tieng, loi 3 tieng tram; kem giong doc `vi-VN` qua Web Speech API.
- Dong ho dem nguoc tran 3 phut lay `deadline_at` tu API, tick cuc bo moi giay; con 30s thi doc canh bao dung mot lan cho moi don.
- Am thanh trinh duyet can mot cu cham de mo khoa; chip trang thai canh dong ho cho biet da bat duoc chua.

Nguyen tac bao tri:

- Giu template dashboard hien tai; chi thay doi layout trong khung live khi co yeu cau ro.
- Khong truyen RTSP credential vao component client.
- Neu doi ty le PiP, cap nhat dong bo voi `warehouse-agent/src/compose/clip-composer.ts`.
