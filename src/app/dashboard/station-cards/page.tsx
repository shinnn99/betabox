import QRCode from "qrcode";
import { CONTROL_CARDS } from "@/lib/station/control-cards";

/**
 * Trang in thẻ QR điều khiển dán ở bàn.
 *
 * Là Server Component: mã QR vẽ sẵn thành SVG ở máy chủ nên trang in ra
 * luôn giống nhau, không phụ thuộc trình duyệt của máy bàn và không tải
 * thêm JavaScript. Thẻ chỉ chứa chuỗi cố định (`BETABOX:...`), không có dữ
 * liệu kho nào, nên in chung cho mọi bàn và mọi kho.
 */
export const metadata = {
  title: "Thẻ điều khiển bàn",
};

export default async function StationCardsPage() {
  const cards = await Promise.all(
    CONTROL_CARDS.map(async (card) => ({
      ...card,
      svg: await QRCode.toString(card.code, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
      }),
    })),
  );

  return (
    <div className="mx-auto max-w-5xl p-6 print:p-0">
      <div className="mb-5 print:hidden">
        <h1 className="text-xl font-bold text-slate-900">Thẻ điều khiển bàn</h1>
        <p className="mt-1 text-sm text-slate-600">
          In trang này, cắt rời và dán ở bàn. Nhân viên quét thẻ bằng súng quét
          hoặc đưa trước camera đọc mã, giống như quét một mã vận đơn.
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-slate-600 space-y-0.5">
          <li>
            <b>NHẬN HOÀN</b> / <b>ĐÓNG HÀNG</b>: đổi chế độ bàn. Bàn đóng hàng
            tự quay về chế độ đóng hàng sau 5 phút không thao tác, và khi đóng
            ca.
          </li>
          <li>
            <b>HÀNG OK / HỎNG / THIẾU / TRÁO</b> và <b>KẾT THÚC</b>: dùng khi
            đang mở một kiện hàng hoàn.
          </li>
          <li>Mã quét ở chế độ nhận hoàn không tính vào số đơn của nhân viên.</li>
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 print:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.code}
            className="break-inside-avoid rounded-xl border-2 border-slate-800 bg-white p-3 text-center"
          >
            <p className="text-base font-extrabold tracking-wide text-slate-900">
              {card.title}
            </p>
            <div
              className="mx-auto my-2 h-36 w-36 [&>svg]:h-full [&>svg]:w-full"
              // QR do thư viện qrcode sinh ở máy chủ từ hằng số trong mã
              // nguồn, không có dữ liệu người dùng.
              dangerouslySetInnerHTML={{ __html: card.svg }}
            />
            <p className="text-[11px] leading-tight text-slate-600">{card.hint}</p>
            <p className="mt-1 font-mono text-[9px] text-slate-400">{card.code}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
