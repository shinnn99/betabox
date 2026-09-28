"use client";

import { shouldDiagnoseHttpStatus, type EventFailureKind } from "@/lib/diagnostics/event-failure";

// ============================================================================
// apiFetch — Client wrapper cho fetch.
//
// Vế 4 (chống ghi-nhầm 2-tab): với POST/PUT/DELETE, wrapper tự thêm header
// x-render-org-id (đọc từ data-render-org-id trên wrapper div do layout
// dashboard nhúng server-side). Guard so vs org-trong-token → lệch → 409.
// Client wrapper phát hiện 409 org_context_changed → tự reload để đồng bộ.
//
// GET không thêm header (đọc lệch không nguy data — đường 3 poll xử tab-làm-mới).
//
// KHÔNG còn URL prefix (/platform/org/{X}/api/*) — cookie impersonate carry
// org-id tới proxy. Client fetch /api/* như tenant thường.
// ============================================================================

const RENDER_ORG_ID_HEADER = "x-render-org-id";
const RENDER_ORG_ID_ATTR = "data-render-org-id";

function getRenderOrgIdFromDOM(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[${RENDER_ORG_ID_ATTR}]`);
  return el?.getAttribute(RENDER_ORG_ID_ATTR) || null;
}

function isWriteMethod(method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export interface FailureDiagnosticSpec {
  agentId: string | null | undefined;
  eventName: string;
  targetType?: string;
  targetId?: string;
}

export interface ApiFetchInit extends RequestInit {
  /** Gửi khi request mất mạng, timeout hoặc nhận bất kỳ HTTP 4xx/5xx nào. */
  diagnoseOnFailure?: FailureDiagnosticSpec;
}

/** Best-effort: không để lỗi của đường chẩn đoán che mất lỗi gốc trên UI. */
export async function reportEventFailure(
  spec: FailureDiagnosticSpec,
  failure: { kind: EventFailureKind; httpStatus?: number; errorCode?: string },
): Promise<boolean> {
  if (!spec.agentId) return false;
  const headers = new Headers({ "Content-Type": "application/json" });
  const renderOrgId = getRenderOrgIdFromDOM();
  if (renderOrgId) headers.set(RENDER_ORG_ID_HEADER, renderOrgId);
  try {
    const res = await fetch("/api/event-diagnostics", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({
        agent_id: spec.agentId,
        event_name: spec.eventName,
        target_type: spec.targetType ?? null,
        target_id: spec.targetId ?? null,
        failure_kind: failure.kind,
        http_status: failure.httpStatus ?? null,
        error_code: failure.errorCode ?? null,
        occurred_at: new Date().toISOString(),
        correlation_id: crypto.randomUUID(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: ApiFetchInit,
  // Legacy param: giữ signature để 51 chỗ gọi cũ không break. Bỏ qua giá trị.
  _legacyOrgId?: string | null
): Promise<Response> {
  void _legacyOrgId;

  const method = init?.method;
  const diagnostic = init?.diagnoseOnFailure;
  const nextInit: RequestInit = init ? { ...init } : {};
  delete (nextInit as ApiFetchInit).diagnoseOnFailure;

  if (isWriteMethod(method)) {
    const renderOrgId = getRenderOrgIdFromDOM();
    if (renderOrgId) {
      const headers = new Headers(nextInit.headers);
      headers.set(RENDER_ORG_ID_HEADER, renderOrgId);
      nextInit.headers = headers;
    }
  }

  let res: Response;
  try {
    res = await fetch(input, nextInit);
  } catch (err) {
    if (diagnostic) {
      const timeout = err instanceof DOMException && err.name === "AbortError";
      void reportEventFailure(diagnostic, { kind: timeout ? "timeout" : "network" });
    }
    throw err;
  }

  if (diagnostic && shouldDiagnoseHttpStatus(res.status)) {
    let errorCode: string | undefined;
    try {
      const body = (await res.clone().json()) as { error?: unknown };
      if (typeof body.error === "string") errorCode = body.error.slice(0, 80);
    } catch {
      // Body không phải JSON — status vẫn đủ để kích hoạt chẩn đoán.
    }
    void reportEventFailure(diagnostic, {
      kind: res.status === 408 ? "timeout" : res.status >= 500 ? "http_5xx" : "http_4xx",
      httpStatus: res.status,
      errorCode,
    });
  }

  // 409 org_context_changed → cookie đã đổi ở tab khác, reload để đồng bộ.
  // Chỉ auto-reload khi status 409 + response error là org_context_changed
  // (không reload cho 409 khác).
  if (res.status === 409) {
    // Clone để không consume body của caller
    try {
      const clone = res.clone();
      const data = (await clone.json()) as { error?: string };
      if (data.error === "org_context_changed") {
        window.location.reload();
        // Return promise không resolve để caller không tiếp tục xử lý (page sẽ reload)
        return new Promise<Response>(() => {});
      }
    } catch {
      // Không parse được JSON → không phải ca org_context_changed, trả nguyên
    }
  }

  return res;
}

// ============================================================================
// LEGACY exports — giữ để 51 chỗ import không break, no-op runtime.
// Sẽ xóa sau khi grep clean các import cũ.
// ============================================================================

/** @deprecated Không cần orgId từ URL nữa — cookie carry. */
export function useImpersonatingOrgId(): string | null {
  return null;
}

/** @deprecated Không cần Provider nữa — layout dashboard nhúng data-attribute. */
export function ImpersonateProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
