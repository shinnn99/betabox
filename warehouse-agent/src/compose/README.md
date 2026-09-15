# warehouse-agent/src/compose

Folder nay chua logic cat/ghep clip proof tren may agent.

Vai tro chinh:

- Nhan danh sach segment local cua camera overview va QR.
- Noi segment moi goc camera thanh file tam.
- Seek dung cua so clip va render mot MP4 cuoi cung.

Nhung diem da xu ly trong luong 2-camera:

- Output layout giong live station: overview 1920x1080, QR PiP 640x360 o goc tren phai.
- Neu thieu mot goc camera, output van render duoc va chen thong tin canh bao.
- Encode ve H.264 (`libx264`, `yuv420p`, `faststart`) de browser/Supabase doc on dinh.

Nguyen tac bao tri:

- Khong cat/ghep neu khong co request tu backend.
- Gioi han duration phai dong bo voi `src/lib/order-proof/clip-window.ts`.
- Neu thay doi layout, cap nhat ca `src/components/station/LiveLayout.tsx`.
