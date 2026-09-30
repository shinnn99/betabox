// FILE NÀY DO MÁY SINH RA — đừng sửa tay.
// Nguồn: phần "Phát hành cho người dùng" trong changelog/*.md
// Sinh lại: pnpm build:changelog

import type { Release } from "./types";

export const GENERATED_RELEASES: Release[] = [
  {
    "agentVersion": "0.13.1",
    "date": "2026-09-30",
    "title": "Bản 0.13.1 — đã thay bằng 0.13.2",
    "summary": "Bản này phát hành sáng 30/09 rồi phát hiện ngay trong ngày là nó dựng thiếu một bản sửa (đổi tên file hàng đợi trên Windows) đang nằm ở nhánh khác.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Đã thay bằng bản 0.13.2",
        "detail": "Phần quét mã của 0.13.1 và 0.13.2 y hệt nhau. Máy nào đã cài 0.13.1 thì nâng lên 0.13.2 để có thêm bản sửa kia. Không cần làm gì khác."
      }
    ],
    "scale": "nho"
  },
  {
    "agentVersion": "0.13.2",
    "date": "2026-09-30",
    "title": "Quét mã nhanh trở lại",
    "summary": "Từ bản cài ngày 24/09 — bản thêm khả năng đọc mã vạch — máy quét bằng camera trở nên chậm hẳn: nhân viên phải giơ nhãn lên và giữ yên khá lâu mã mới được nhận, trong khi trước đó gần như giơ lên là ăn ngay.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Nhận mã nhanh như trước khi thêm mã vạch",
        "detail": "Nguyên nhân không phải do thêm mã vạch như tưởng ban đầu, mà do bản 24/09 cùng lúc nâng độ nét ảnh đưa vào máy đọc lên quá cao. Mỗi giây camera gửi 10 ảnh, nhưng máy xử lý một ảnh còn không kịp trước khi ảnh sau tới, nên phần lớn ảnh bị bỏ qua — mà luật xác nhận lại đòi hai ảnh liên tiếp cùng đọc ra một mã mới tính là quét xong. Nay máy đọc theo hai bước: bước nhanh thử trước với những loại mã hay gặp nhất trên nhãn vận đơn, trúng ngay thì xong luôn; chỉ khi bước nhanh không thấy gì mới soi kỹ. Thời gian xử lý mỗi ảnh giảm từ khoảng 189 xuống còn khoảng 12 phần nghìn giây, nên không còn ảnh nào bị bỏ."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Không còn sót lượt ghi vì Windows giữ file",
        "detail": "Phần mềm diệt virus hoặc trình lập chỉ mục của Windows đôi khi giữ file trong chốc lát, làm máy kho ghi hụt một lượt vào sổ chờ gửi. Nay máy tự thử lại thay vì bỏ qua. Mất điện giữa chừng vẫn an toàn như trước."
      },
      {
        "tag": "Cải tiến",
        "title": "Vẫn đọc được đúng những gì đang đọc được",
        "detail": "Mã QR nhỏ trên nhãn TikTok, mã vạch trên nhãn J&T và các loại mã ít gặp đều vẫn đọc được như trước. Độ nét ảnh có hạ xuống một bậc, nhưng đã kiểm để chắc chắn dừng đúng ở mức vẫn đọc được mã nhỏ nhất đang dùng."
      }
    ]
  },
  {
    "agentVersion": "0.13.0",
    "date": "2026-09-26",
    "title": "Máy kho tự báo tình trạng, clip kiện hoàn quay đủ 5 phút",
    "summary": "Trước đây muốn biết máy kho đang chạy bản nào, ổ còn bao nhiêu, camera nào đang ghi thì phải có người tới kho kiểm tay. Clip kiện hoàn 5 phút thì chỉ quay được 3 phút đầu, vì clip dài hơn vượt giới hạn tải lên.",
    "items": [
      {
        "tag": "Mới",
        "title": "Máy kho tự báo tình trạng mỗi 30 giây",
        "detail": "Phiên bản, camera nào đang ghi, ổ đĩa còn mấy ngày, bao nhiêu lượt quét đang chờ gửi. Hệ thống tự cảnh báo khi ổ sắp đầy hoặc máy chạy bản cũ — không cần ai tới kho kiểm."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Clip kiện hoàn quay đủ thời gian mở hàng",
        "detail": "Clip dài tự giảm dung lượng cho vừa giới hạn tải lên, nên kiện hoàn 5 phút có video đủ 5 phút thay vì bị cắt ở phút thứ 3. Clip đơn đi giữ nguyên chất lượng như cũ."
      },
      {
        "tag": "Cải tiến",
        "title": "Nhật ký máy kho gọn hơn",
        "detail": "Cùng một cảnh báo lặp lại nhiều lần được gom thành một dòng, nên lỗi thật không còn bị chôn giữa hàng nghìn dòng nhiễu."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Không còn mất lượt quét khi mạng chậm",
        "detail": "Lượt quét và báo cáo video chờ gửi lại có thể bị mất nếu có lượt mới xếp hàng đúng lúc máy kho đang gửi lại. Nay không còn mất."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Xem video không còn làm chậm lượt quét",
        "detail": "Máy kho chỉ cắt và tải lên một video một lúc, nên việc xem video không còn chiếm hết mạng khiến lượt quét lên chậm 1–3 phút."
      }
    ]
  },
  {
    "agentVersion": null,
    "date": "2026-09-26",
    "title": "Thời gian đóng đơn không còn bị âm khi lượt quét tới chậm",
    "summary": "Sáng 26/09 ở kho Đại Kim, lượt quét tới hệ thống chậm và lộn thứ tự, làm vài đơn có thời gian đóng âm (−25 giây, −44 giây) và video đơn này trùm lên đơn khác.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Xếp lượt quét theo đúng giờ quét",
        "detail": "Lượt quét tới muộn được đặt vào đúng chỗ theo giờ quét: đơn trước kết thúc đúng lúc quét mã này, không còn thời gian âm, video mỗi đơn không còn chồng lên đơn khác. Các đơn đã ghi sai sáng 26/09 sửa lại được bằng một lần chạy công cụ sửa dữ liệu."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Video đơn vừa đóng không còn báo \"Segment cuối chưa đóng\"",
        "detail": "Mở video ngay khi đơn vừa đóng, trang chờ đoạn video cuối đóng rồi tự cắt — không còn báo lỗi và bắt bấm \"Thử lại\". Các đơn đã báo lỗi này tự cắt lại khi mở ra xem."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Cảnh báo dung lượng video đúng với bàn hai camera",
        "detail": "Bàn hai camera được ghép và nén lại nên video chỉ khoảng 70 MB cho 3 phút; cảnh báo \"có nguy cơ vượt giới hạn ~130 MiB\" ở gần như mọi đơn là báo nhầm và đã hết."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Camera đã tháo không còn báo lỗi",
        "detail": "Camera không gắn vào bàn nào mà mất kết nối không còn bị tính là sự cố. Trang Thiết bị hiện \"Không kết nối được\" thay cho \"cập nhật mấy chục giây trước\", kèm nhắc lưu trữ camera nếu đã tháo hẳn."
      }
    ],
    "scale": "lon"
  },
  {
    "agentVersion": null,
    "date": "2026-09-26",
    "title": "Quét bằng súng ở bàn đặt camera: nói đúng lý do",
    "summary": "Bàn đặt nguồn quét là camera mà có người quét bằng súng, lượt quét đó không tạo đơn. Nhật ký trước đây ghi nhầm là \"Mã sai\" hoặc \"Đang chờ xử lý\" mãi mãi.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Nhật ký ghi \"Nguồn quét tắt\"",
        "detail": "Dòng nhật ký nói rõ nguồn nào đang tắt ở bàn — súng hay camera — và lượt quét đó không tạo đơn, để biết phải đổi cấu hình bàn hay đổi cách quét."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Quét lại mã đã có đơn: báo trùng, không lưu",
        "detail": "Quét lại một mã đã thành đơn bằng nguồn đang tắt ở bàn giờ được báo là mã trùng và không lưu lại. Các dòng \"Mã sai / Đang chờ xử lý\" cũ thực ra là quét lại được ghi đúng là \"Trùng\"."
      }
    ],
    "scale": "lon"
  },
  {
    "agentVersion": null,
    "date": "2026-09-26",
    "title": "Lỗi video nói bằng tiếng Việt",
    "summary": "Khi cắt hoặc tải video không thành công, danh sách video và khung xem video trước đây hiện nguyên mã lỗi kỹ thuật (ví dụ \"proof_clip_too_large: 96.6MB…\"). Nay chỉ hiện câu tiếng Việt: lỗi gì và cần làm gì.",
    "items": [
      {
        "tag": "Cải tiến",
        "title": "Câu lỗi video bằng tiếng Việt, kèm việc cần làm",
        "detail": "Ví dụ \"Video của đơn này quá dung lượng để tải lên (96,6 MB, giới hạn 90,0 MB). Bấm Thử lại để cắt lại\". Ổ đĩa máy kho đầy, mạng của kho bị ngắt, máy kho đang bận cũng có câu riêng, nói rõ phải làm gì."
      },
      {
        "tag": "Sửa lỗi",
        "title": "\"Thử lại\" không còn báo nhầm \"Kho đang offline\"",
        "detail": "Bấm Thử lại cho lượt quét lúc chưa mở ca giờ hiện đúng lý do \"Lượt quét khi chưa mở ca — không có video để cắt\", thay vì báo kho mất kết nối."
      }
    ],
    "scale": "nho"
  },
  {
    "agentVersion": "0.12.1",
    "date": "2026-09-25",
    "title": "Bỏ qua mã QR đường link trên nhãn TikTok",
    "summary": "Phiếu TikTok in hai mã QR cạnh nhau: một mã vận đơn và một mã link tới trang bán hàng. Camera bắt trúng cái nào trước thì gửi cái đó lên, nên có lúc hệ thống nhận cái link thay vì mã vận đơn.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Chỉ nhận mã vận đơn, không nhận link",
        "detail": "Máy kho nhận ra mã đường link và bỏ qua, lấy mã vận đơn in ngay cạnh. Trước đây hai mã ngang cỡ nhau trong cùng khung hình còn bị coi là \"hai nhãn cùng lúc\" và không quét được gì — nay hết."
      }
    ]
  },
  {
    "agentVersion": null,
    "date": "2026-09-25",
    "title": "Nhật ký đóng hàng không còn lẫn kiện hoàn",
    "summary": "Trang Giám sát đóng hàng liệt kê mọi lượt quét trong ngày, nên kiện hoàn hiện chung bảng với đơn đi dù hàng hoàn đã có trang theo dõi riêng.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Mỗi luồng một bảng",
        "detail": "Nhật ký đóng hàng chỉ còn đơn đi; kiện hoàn xem ở Giám sát hoàn hàng. Con số tổng cũng trừ phần hoàn ra để không đá nhau với danh sách bên dưới."
      },
      {
        "tag": "Sửa lỗi",
        "title": "Chuỗi không phải mã vận đơn thì không tạo đơn",
        "detail": "Chuỗi quá ngắn, quá dài hoặc có ký tự lạ nay bị ghi là mã không hợp lệ, không tạo đơn và không kích hoạt lưới an toàn hàng hoàn. Các đơn rác đã lỡ sinh ra ở kho đã được dọn sạch."
      }
    ]
  },
  {
    "agentVersion": "0.12.0",
    "date": "2026-09-24",
    "title": "Đọc được mã QR nhỏ và cả mã vạch",
    "summary": "Nhãn TikTok in mã QR nhỏ hơn nhãn thường nên camera không đọc nổi. Nguyên nhân không nằm ở camera: máy kho tự thu nhỏ mọi khung hình trước khi đọc, nên camera nét đến mấy cũng vô ích.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Mã QR nhỏ trên nhãn TikTok giờ đọc được",
        "detail": "Máy kho từng bóp mọi khung hình xuống 640×360 trước khi đọc, một mã 12mm chỉ còn khoảng 12 điểm ảnh. Nay máy kho dò đúng độ phân giải camera và đọc ở cỡ đó."
      },
      {
        "tag": "Mới",
        "title": "Quét trúng mã vạch cũng được",
        "detail": "Mã vạch và QR trên nhãn là cùng một mã vận đơn, nên bắt được cái nào hệ thống nhận cái đó. Khung hình có nhiều mã thì lấy mã được in lặp lại nhiều lần nhất — trên nhãn, mã vận đơn luôn in mấy lần còn mã phân loại chỉ một lần. Không đọc mã sản phẩm trên hộp."
      }
    ]
  },
  {
    "agentVersion": null,
    "date": "2026-09-24",
    "title": "Chuyển qua lại giữa đóng hàng và hoàn hàng không còn kẹt",
    "summary": "Bàn chuyển sang nhận hoàn thì được, nhưng chuyển ngược về đóng hàng thì kẹt lại ở chế độ hoàn.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Bàn về được đóng hàng trong mọi trường hợp",
        "detail": "Máy kho chỉ biết tắt phiên hoàn khi nhận được lệnh, mà lệnh đó chỉ sinh ra ở một đường duy nhất; bốn đường còn lại (bàn tự về sau 5 phút, đóng ca, đổi mục đích bàn, hết hạn phiên) không ai báo máy kho. Nay máy kho tự đối chiếu trạng thái với hệ thống mỗi nhịp."
      },
      {
        "tag": "Mới",
        "title": "Nút \"Ép dừng\" cho bàn do máy khác bật",
        "detail": "Một tab trình duyệt đóng đột ngột sẽ giữ bàn ở chế độ hoàn mà không ai gỡ được. Nay bấm Ép dừng là bàn về đóng hàng ngay."
      },
      {
        "tag": "Cải tiến",
        "title": "Đoạn video giao ca không bị cắt ngang",
        "detail": "Đổi luồng lúc camera đang ghi dở thì đoạn đó vẫn thuộc luồng cũ và được ghi nốt; luồng mới tính từ đoạn kế tiếp. Đúng cả hai chiều."
      }
    ]
  },
  {
    "agentVersion": null,
    "date": "2026-09-24",
    "title": "Báo cáo hiệu suất có phần hàng hoàn",
    "summary": "Trước đây báo cáo chỉ nói về đơn đi. Giờ có đủ phần hàng hoàn, tính riêng để không lẫn vào sản lượng đóng hàng.",
    "items": [
      {
        "tag": "Mới",
        "title": "Tổng đơn hoàn, biểu đồ theo ngày, bảng theo nhân sự",
        "detail": "Bảng \"Báo cáo hoàn hàng theo nhân sự\" dùng đúng các cột của bảng đóng hàng. Bảng cũ đổi tên thành \"Báo cáo đóng hàng theo nhân sự\"."
      },
      {
        "tag": "Cải tiến",
        "title": "Đổi tên \"Thời gian TB\" thành \"Thời gian đóng hàng TB\"",
        "detail": "Để không nhầm với thời gian kiểm hàng hoàn."
      }
    ]
  },
  {
    "agentVersion": null,
    "date": "2026-09-23",
    "title": "Phân quyền chặt hơn và rõ hơn",
    "summary": "Đổi cách vận hành: ai làm được gì nay khác trước. Thao tác không có quyền bị chặn ngay từ nút bấm, không để bấm xong mới báo lỗi.",
    "items": [
      {
        "tag": "Mới",
        "title": "Chỉ chủ sở hữu được xoá tài khoản người dùng",
        "detail": "Admin và trưởng kho vẫn thêm, sửa được như cũ. Xoá là xoá hẳn khỏi hệ thống, không hoàn tác được, nên chỉ một người cầm. Nhật ký thao tác cũ vẫn giữ để đối chiếu."
      },
      {
        "tag": "Mới",
        "title": "Vai trò Xem: thấy mọi trang trừ Quản lý hệ thống",
        "detail": "Xem được bàn, thiết bị, báo cáo, video — nhưng mọi nút ghi đều chặn, và thông tin nhạy cảm (địa chỉ camera, số điện thoại, email nhân viên) bị ẩn."
      },
      {
        "tag": "Cải tiến",
        "title": "Bấm nút không có quyền thì báo ngay tại chỗ",
        "detail": "Nút hiện mờ, bấm vào báo \"Bạn không có quyền …\" thay vì mở form rồi mới báo hỏng."
      }
    ],
    "scale": "lon"
  },
  {
    "agentVersion": "0.11.0",
    "date": "2026-09-22",
    "title": "Chặn ổ đĩa đầy im lặng",
    "summary": "Trước bản này, ổ máy kho đầy là ghi hình dừng mà không ai biết cho tới lúc đi tìm video không thấy.",
    "items": [
      {
        "tag": "Mới",
        "title": "Máy kho tự dọn đoạn cũ khi sắp hết chỗ",
        "detail": "Ngưỡng tính theo SỐ GIỜ GHI còn lại chứ không theo phần trăm ổ, vì mỗi kho ăn đĩa một tốc độ khác nhau. Không đụng vào đoạn còn trong hạn lưu, không đụng vào clip bằng chứng."
      },
      {
        "tag": "Cải tiến",
        "title": "Nhật ký dọn dẹp gửi về hệ thống",
        "detail": "Kèm báo động nếu việc dọn im lặng quá lâu."
      }
    ]
  },
  {
    "agentVersion": "0.10.0",
    "date": "2026-09-21",
    "title": "Thêm luồng hàng hoàn",
    "summary": "Kho nhận hàng hoàn ngay trên bàn đang đóng hàng. Kiện hoàn được quay video riêng, đếm riêng, và KHÔNG tính vào sản lượng đóng gói của nhân viên.",
    "items": [
      {
        "tag": "Mới",
        "title": "Bật nhận hoàn theo từng bàn, chạy song song với đóng hàng",
        "detail": "Bàn 1-2 đóng hàng trong khi bàn 3-4 nhận hoàn. Camera vẫn ghi liên tục; thứ thay đổi là đoạn video đó thuộc luồng nào."
      },
      {
        "tag": "Mới",
        "title": "Hai trang mới: Giám sát hoàn hàng và Bằng chứng hoàn hàng",
        "detail": "Cùng bố cục với hai trang đóng hàng để không phải học lại. Mỗi kiện hoàn có video riêng và hồ sơ khiếu nại kèm đồng hồ đếm ngược hạn khiếu nại với sàn."
      },
      {
        "tag": "Mới",
        "title": "Video hàng hoàn giữ riêng 7 ngày",
        "detail": "Đoạn video thuần hàng hoàn chỉ cần đủ cho hạn khiếu nại nên giữ ngắn hơn, đỡ tốn ổ đĩa máy kho. Số ngày chỉnh được ở Cấu hình kho."
      }
    ]
  },
  {
    "agentVersion": "0.10.1",
    "date": "2026-09-21",
    "title": "Clip không còn kẹt \"thất bại\" khi mạng tải lên chậm",
    "summary": "Mạng kho yếu thì clip 34 MB hết giờ chờ trong lúc file vẫn đang lên, rồi bị đánh là hỏng dù thật ra đã lên xong.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Clip đã lên rồi thì được ghi nhận là xong",
        "detail": "Hệ thống đối chiếu kích thước file trên kho lưu trữ với file vừa cắt, khớp mới chốt. Thời gian chờ tải lên tự gấp đôi sau mỗi lần thử thay vì thử lại với đúng thời gian vừa thua."
      }
    ]
  },
  {
    "agentVersion": "0.9.0",
    "date": "2026-09-18",
    "title": "Một máy kho phục vụ mọi bàn, mỗi bàn hai camera",
    "summary": "Đổi cách vận hành: từ một camera một máy quét thành hai camera mỗi bàn — một toàn cảnh, một chuyên đọc mã. Video bằng chứng ghép hai hình vào một.",
    "items": [
      {
        "tag": "Mới",
        "title": "Camera gắn theo bàn, ghi theo ca của bàn đó",
        "detail": "Mở ca bàn nào thì chỉ camera của bàn đó bật ghi."
      },
      {
        "tag": "Mới",
        "title": "Quét mã bằng camera thay cho máy quét cầm tay",
        "detail": "Bàn nào muốn giữ máy quét cầm tay vẫn giữ được, chọn theo từng bàn."
      },
      {
        "tag": "Cải tiến",
        "title": "Camera nhận theo địa chỉ MAC",
        "detail": "Đổi IP do mạng cấp lại thì máy kho tự tìm ra camera, không phải khai lại."
      }
    ]
  },
  {
    "agentVersion": "0.9.1",
    "date": "2026-09-18",
    "title": "Ô góc QR trong video bằng chứng đứng dọc",
    "summary": "Camera QR đặt chế độ hình dọc để nhìn trọn nhãn vận đơn; ô ngang cũ chỉ cắt được một dải giữa của nhãn.",
    "items": [
      {
        "tag": "Cải tiến",
        "title": "Ô góc đổi thành 360×640",
        "detail": "Cùng diện tích, vẫn ở góc trên phải, hình không bị xoay."
      }
    ]
  },
  {
    "agentVersion": "0.8.9",
    "date": "2026-08-11",
    "title": "Đơn không còn kẹt \"Đang cắt\" vĩnh viễn",
    "summary": "Ngày 11/08 ở kho Đại Kim, lời báo kết quả cắt clip của máy kho rơi mất giữa đường nên ô trạng thái quay mãi, không có cả nút thử lại.",
    "items": [
      {
        "tag": "Sửa lỗi",
        "title": "Máy kho gửi lại lời báo cho tới khi hệ thống nhận",
        "detail": "Lời báo không gửi được thì ghi xuống ổ đĩa và gửi lại mỗi phút, sống qua cả việc khởi động lại máy."
      }
    ]
  }
];
