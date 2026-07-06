/**
 * B1.3 telemetry: đếm v1 vs v2 signature per agent.
 *
 * Mục đích: quan sát rollout. Điều kiện enforce v2 (drop v1) yêu cầu:
 *   1. Agent đã upgrade (bằng chứng: 0 v1 request trong cửa sổ N phút).
 *   2. Heartbeat v2 confirmed.
 *   3. Command poll v2 confirmed.
 *
 * Impl minimal: in-memory counter reset sau CYCLE_MS (mặc định 15 phút),
 * log summary khi cycle rollover. Không blocking auth path — telemetry
 * write không thể fail-close request.
 *
 * KHÔNG dùng DB counter cho MVP (thêm write mỗi request). Sau khi rollout
 * ổn định, có thể chuyển sang Vercel Analytics hoặc bảng riêng nếu cần
 * historical.
 */

const CYCLE_MS = 15 * 60 * 1000;

interface CycleState {
  startedAt: number;
  byVersionByAgent: Map<string, { v1: number; v2: number }>;
}

let current: CycleState = createCycle();

function createCycle(): CycleState {
  return {
    startedAt: Date.now(),
    byVersionByAgent: new Map(),
  };
}

function rollIfExpired(now: number): void {
  if (now - current.startedAt < CYCLE_MS) return;
  const snapshot = current;
  current = createCycle();
  // Log summary. Không đợi flush.
  const lines: string[] = [];
  let totalV1 = 0;
  let totalV2 = 0;
  for (const [agentId, counts] of snapshot.byVersionByAgent) {
    lines.push(`agent=${agentId} v1=${counts.v1} v2=${counts.v2}`);
    totalV1 += counts.v1;
    totalV2 += counts.v2;
  }
  console.log(
    `[agent-sig-telemetry] cycle rollover total_v1=${totalV1} total_v2=${totalV2} agents=${snapshot.byVersionByAgent.size}`,
  );
  for (const l of lines) console.log(`[agent-sig-telemetry]   ${l}`);
}

export function recordAgentSigVersion(
  agentId: string,
  version: "v1" | "v2",
): void {
  const now = Date.now();
  rollIfExpired(now);
  let counts = current.byVersionByAgent.get(agentId);
  if (!counts) {
    counts = { v1: 0, v2: 0 };
    current.byVersionByAgent.set(agentId, counts);
  }
  counts[version] += 1;
}

/**
 * Testing helper — reset counter + trả state đang có. Không export cho prod.
 */
export function _debugCycleState(): CycleState {
  return current;
}

export function _debugReset(): void {
  current = createCycle();
}
