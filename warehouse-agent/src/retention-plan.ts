import { promises as fs } from "node:fs";
import path from "node:path";
import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { fetchWithRetrySigned } from "./fetch-error";

/**
 * Danh sách segment thuần hàng hoàn, để script cleanup xoá sau 7 ngày.
 *
 * Vì sao ghi ra file: script PowerShell dọn ổ đĩa chạy bằng Task Scheduler,
 * độc lập với tiến trình agent và KHÔNG gọi mạng (có thể chạy lúc agent đang
 * chết, hoặc lúc kho mất mạng). File cache là cách duy nhất để nó biết cloud
 * đã phân loại những đoạn nào.
 *
 * Cùng lý do với `retention-cache.json` — xem retention-cache.ts.
 *
 * Thiếu file, hỏng JSON hay danh sách rỗng đều là chuyện bình thường: lúc
 * đó script chỉ xoá theo hạn chung. Không bao giờ vì lỗi mà xoá rộng hơn.
 */

const PLAN_FILENAME = "retention-plan.json";

export interface RetentionPlan {
  /** Số ngày giữ segment thuần hàng hoàn (mặc định 7). */
  return_retention_days: number;
  /** Đường dẫn tương đối trong RECORDING_DIR, VD "dahua_3/2026/09/21/....mp4". */
  files: string[];
  updated_at: string;
}

function planPath(): string {
  return path.join(process.cwd(), PLAN_FILENAME);
}

/** Ghi cache. Ghi tạm rồi đổi tên để script không đọc phải file dở. */
export async function writeRetentionPlan(plan: {
  returnRetentionDays: number;
  files: string[];
}): Promise<void> {
  const content: RetentionPlan = {
    return_retention_days: plan.returnRetentionDays,
    files: plan.files,
    updated_at: new Date().toISOString(),
  };
  const target = planPath();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(content, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Đọc cache. Trả null khi thiếu file, hỏng JSON hoặc số ngày vô lý.
 *
 * Dùng để trả lời "clip này cắt không được vì segment đã quá hạn hàng
 * hoàn, hay vì mất file thật?". Trả nhầm hướng nào cũng tốn người: một
 * bên là báo động giả, bên kia là nuốt mất lỗi ổ đĩa.
 */
export async function readRetentionPlan(): Promise<RetentionPlan | null> {
  try {
    const raw = await fs.readFile(planPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RetentionPlan>;
    const days = parsed.return_retention_days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
      return null;
    }
    if (!Array.isArray(parsed.files)) return null;
    return {
      return_retention_days: days,
      files: parsed.files.filter((f): f is string => typeof f === "string"),
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    };
  } catch {
    return null;
  }
}

export interface FetchRetentionPlanResult {
  ok: boolean;
  status: number;
  files: number;
}

/**
 * Hỏi cloud danh sách segment hàng hoàn rồi ghi xuống cache.
 *
 * Lỗi mạng hoặc cloud chưa có route (bản cloud cũ) đều không ghi đè cache
 * đang có: danh sách cũ vẫn đúng hơn là không có gì.
 */
export async function refreshRetentionPlan(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
}): Promise<FetchRetentionPlanResult> {
  const body = JSON.stringify({});
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.retentionPlan}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.retentionPlan,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) return { ok: false, status: res.status, files: 0 };

    const json = (await res.json()) as {
      return_retention_days?: number;
      files?: string[];
    };
    const days = Number(json.return_retention_days);
    const files = Array.isArray(json.files) ? json.files.filter((f) => typeof f === "string") : [];
    await writeRetentionPlan({
      returnRetentionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7,
      files,
    });
    return { ok: true, status: res.status, files: files.length };
  } catch {
    return { ok: false, status: 0, files: 0 };
  }
}
