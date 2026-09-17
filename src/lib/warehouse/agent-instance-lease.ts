/**
 * Một mã agent chỉ được MỘT tiến trình nhận lệnh tại một thời điểm.
 *
 * Vì sao: mã + secret giống nhau thì cloud không phân biệt được hai máy.
 * Ca thật 17/09/2026: máy kho chạy bản agent cũ cùng mã AGENT_KHO_HN_01,
 * giành mọi lệnh ghi và cắt clip của máy chạy bản mới. Segment nó báo lên
 * thiếu agent_id nên clip không cắt được — hỏng im lặng, mất nửa ngày dò.
 *
 * Cách làm: mỗi tiến trình agent mới gửi `agent_instance_id` (ổn định qua
 * các lần khởi động lại trên cùng máy) trong body đã ký. Cloud giữ "phiên
 * đang giữ quyền" kèm mốc thấy gần nhất. Hết hạn thuê thì phiên khác được
 * nhận quyền — máy chết hẳn không khoá mã agent mãi.
 *
 * Agent bản cũ không gửi mã phiên: vẫn chạy như trước, TRỪ khi đang có một
 * phiên mới giữ quyền — lúc đó nhận danh sách lệnh rỗng. Kho chỉ chạy bản
 * cũ không bị ảnh hưởng gì.
 */

/** Thời hạn thuê. Agent hỏi lệnh mỗi 3 giây, 30 giây là ~10 nhịp lỡ. */
export const AGENT_INSTANCE_LEASE_MS = 30_000;

export type AgentInstanceDecision =
  /** Agent cũ, không có phiên mới nào giữ quyền: chạy như trước. */
  | { kind: "legacy_allowed" }
  /** Agent cũ trong lúc một phiên mới đang giữ quyền: không cấp lệnh. */
  | { kind: "legacy_blocked"; activeInstanceId: string }
  /** Đúng phiên đang giữ quyền: cấp lệnh, gia hạn thuê. */
  | { kind: "owner" }
  /** Chưa ai giữ, hoặc thuê đã hết hạn: giành quyền (có điều kiện). */
  | { kind: "claim" }
  /** Phiên khác đang giữ quyền còn hạn: từ chối. */
  | { kind: "conflict"; activeInstanceId: string };

export function decideAgentInstance(args: {
  instanceId: string | null;
  activeInstanceId: string | null;
  activeSeenAt: string | null;
  now: Date;
  leaseMs?: number;
}): AgentInstanceDecision {
  const leaseMs = args.leaseMs ?? AGENT_INSTANCE_LEASE_MS;
  const seenMs = args.activeSeenAt ? new Date(args.activeSeenAt).getTime() : NaN;
  const leaseValid =
    Boolean(args.activeInstanceId) &&
    Number.isFinite(seenMs) &&
    args.now.getTime() - seenMs < leaseMs;

  if (!args.instanceId) {
    return leaseValid
      ? { kind: "legacy_blocked", activeInstanceId: args.activeInstanceId as string }
      : { kind: "legacy_allowed" };
  }
  if (args.instanceId === args.activeInstanceId) return { kind: "owner" };
  if (!leaseValid) return { kind: "claim" };
  return { kind: "conflict", activeInstanceId: args.activeInstanceId as string };
}

/** Mốc thấy gần nhất cũ hơn mốc này thì thuê đã hết hạn. */
export function leaseExpiredBefore(now: Date, leaseMs = AGENT_INSTANCE_LEASE_MS): string {
  return new Date(now.getTime() - leaseMs).toISOString();
}
