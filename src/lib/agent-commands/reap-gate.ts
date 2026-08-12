import "server-only";

/**
 * Cửa chặn nhịp cho `reap_stale_agent_commands` trong đường poll-commands.
 *
 * Trước (2026-08-12): mỗi lượt poll gọi RPC reap một lần. Đo thật trên
 * kho Đại Kim: 31,2 request agent/phút, trong đó ~20 là poll → RPC reap
 * chạy ~20 lần/phút để canh một ngưỡng 2 PHÚT. Dư 50 lần. Mỗi lượt là
 * một round-trip PostgREST ghi, tính vào egress Database — khoản đang
 * nghi là nguồn chính của 5 GB/tháng.
 *
 * Sau: chỉ gọi RPC khi lần reap trước đã quá `REAP_MIN_INTERVAL_MS`.
 *
 * ĐẾM THEO THỜI GIAN, KHÔNG THEO LƯỢT POLL. "1 trên N lượt" nghe tương
 * đương nhưng nó buộc vào nhịp poll: giãn poll 3s → 15s là reaper tự
 * nhân 5 lần chu kỳ và vượt ngưỡng mà không ai thấy. Mốc thời gian độc
 * lập với nhịp poll, nên quyết định giãn poll sau này không phá cái này.
 *
 * ---------------------------------------------------------------------
 * VÌ SAO 15 GIÂY, KHÔNG PHẢI 30
 *
 * RPC đặt visibility timeout theo type: `ping` 30 giây, còn lại 2 phút.
 * Với 2 phút thì 30 giây dư 4 lần — nhưng với nhánh `ping` thì cửa 30
 * giây khiến lệnh chết bị phát hiện muộn tới 60 giây, tức GẤP ĐÔI chính
 * ngưỡng nó canh.
 *
 * `ping` hiện là loại chết: mọi row trong DB đều từ 01/07/2026 và đều
 * `done`, không còn chỗ nào trong code phát sinh. Nên 30 giây cũng không
 * cắn gì hôm nay. Chọn 15 giây vì nó giữ biên an toàn dưới ngưỡng nhỏ
 * nhất mà RPC đang khai báo — nếu mai kia ai hồi sinh `ping`, cửa này
 * không âm thầm làm hỏng nó. Chênh lệch tiết kiệm giữa 15s và 30s chỉ là
 * 2 truy vấn/phút, không đáng đánh đổi lấy một cái bẫy ngủ trong code.
 *
 * Test `reap-gate.test.ts` khoá quan hệ này lại: hằng số phải luôn nhỏ
 * hơn ngưỡng `ping` trong RPC.
 * ---------------------------------------------------------------------
 *
 * TRẠNG THÁI NẰM TRONG RAM — VÌ SAO Ở ĐÂY LÀ ĐƯỢC
 *
 * Có cọc cũ: "state phải sống lâu hơn request, RAM ≠ trạng thái chung"
 * (Map in-memory không chia sẻ giữa các lambda Vercel). Cọc đó nói về
 * trạng thái mang tính ĐÚNG/SAI — debounce, rate-limit, nonce: mất RAM
 * là mất tính đúng.
 *
 * Ở đây RAM chỉ là gợi ý tối ưu, và MỌI cách hỏng đều rơi về đúng hành
 * vi hiện tại chứ không tệ hơn:
 *   - nhiều tiến trình (PM2 cluster) → mỗi tiến trình giữ mốc riêng →
 *     reap NHIỀU hơn, không ít hơn.
 *   - restart tiến trình → mốc mất → reap ngay lượt kế, không bỏ sót.
 * Không có nhánh nào dẫn tới "reap thưa hơn dự định". Đó là lý do dùng
 * RAM ở đây an toàn, khác hẳn ca debounce.
 *
 * Bộ nhớ: Map khoá theo agent_id, chặn trên bằng số agent của hệ (vài
 * chục), không phải theo request — không phình.
 *
 * ---------------------------------------------------------------------
 * CỌC KÍCH HOẠT — KHI LÊN ~10 KHO THÌ TÁCH REAPER RA KHỎI ĐƯỜNG POLL
 *
 * RPC gọi với `p_agent_id` nên mỗi agent chỉ dọn lệnh của chính nó; tải
 * tăng tuyến tính theo số agent. Với 2 agent thì 4 lượt/phút, không đáng
 * kể. Với 20 kho là 40 lượt/phút nằm ngay trong đường nóng của poll —
 * lúc đó reaper phải thành job định kỳ trên VPS (gọi RPC với
 * `p_agent_id = null`, quét toàn cục 1 lần) và bỏ hẳn khỏi route này.
 */

export const REAP_MIN_INTERVAL_MS = Number(
  process.env.REAP_MIN_INTERVAL_MS ?? 15_000,
);

/**
 * Quyết định thuần — tách ra để test không cần đụng đồng hồ thật.
 * `lastReapAtMs === undefined` (chưa từng reap trong tiến trình này) →
 * luôn cho chạy.
 */
export function shouldReap(
  lastReapAtMs: number | undefined,
  nowMs: number,
  minIntervalMs: number = REAP_MIN_INTERVAL_MS,
): boolean {
  if (lastReapAtMs === undefined) return true;
  return nowMs - lastReapAtMs >= minIntervalMs;
}

export class ReapGate {
  private lastByAgent = new Map<string, number>();

  /**
   * Trả true nếu lượt này ĐƯỢC phép gọi RPC reap, và ghi mốc luôn.
   * Gọi một lần cho mỗi request; không gọi rồi bỏ kết quả.
   */
  tryAcquire(agentId: string, nowMs: number = Date.now()): boolean {
    if (!shouldReap(this.lastByAgent.get(agentId), nowMs)) return false;
    this.lastByAgent.set(agentId, nowMs);
    return true;
  }

  /** Chỉ dùng cho test. */
  reset(): void {
    this.lastByAgent.clear();
  }
}

export const reapGate = new ReapGate();
