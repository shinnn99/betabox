# src/lib/order-proof

Folder nay chua logic tinh cua so video bang chung cho mot `packing_events` row.

Vai tro chinh:

- Tinh `clip_start` va `clip_end` dua tren scan hien tai, scan tiep theo, session end va timing config.
- Tim segment camera phu hop voi cua so clip.
- Uoc tinh rui ro dung luong truoc khi cat/ghep.
- Mo ta duong dan va trang thai clip proof de API/agent xu ly tiep.

Nhung diem da xu ly trong luong 2-camera:

- `clip-window.ts` ap tran ky thuat cho clip, hien tai target la toi da 180 giay theo yeu cau van hanh.
- `clip-resolver.ts` chon segment theo boundary chat nhat co the de khong lay nham video cua ban/ca khac.
- `proof-clip-gate.ts` va `proof-size-estimate.ts` chan cac request proof co nguy co vuot kha nang upload/xu ly.

Nguyen tac bao tri:

- Folder nay khong cat video truc tiep; agent moi cham file segment local.
- Khong tu mo rong cua so clip qua station/session khac de "tim cho du video".
- Neu thay doi layout output, cap nhat dong bo voi `src/components/station/LiveLayout.tsx` va `warehouse-agent/src/compose/clip-composer.ts`.

## Ten file video giao cho khach

`clip-file-name.ts` sinh ten `<ma van don>-<yyyyMMdd>-<HHmmss>.mp4` theo gio Viet Nam, lay moc tu `packing_events.scanned_at`.

- Dung `scanned_at` chu khong dung gio tao clip: sinh lai clip cho cung mot don phai ra cung mot ten.
- `bucket_path` trong Storage van giu dang `org/pe_id/clip_id.mp4`. Ten dep chi ap o lop tai xuong qua query `?download=` (Storage tra `Content-Disposition: attachment`).
- URL phat inline cho the `<video>` KHONG duoc kem `?download=`; hai URL tach rieng trong `src/lib/watch/proof-clip-signed-url.ts`.
- Ten file duoc tinh lai moi lan cap signed URL nen clip cu (cot `clip_name` con la UUID) van tai ve dung ten.
