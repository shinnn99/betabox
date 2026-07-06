"use client";

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

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  // Legacy param: giữ signature để 51 chỗ gọi cũ không break. Bỏ qua giá trị.
  _legacyOrgId?: string | null
): Promise<Response> {
  void _legacyOrgId;

  const method = init?.method;
  const nextInit: RequestInit = init ? { ...init } : {};

  if (isWriteMethod(method)) {
    const renderOrgId = getRenderOrgIdFromDOM();
    if (renderOrgId) {
      const headers = new Headers(nextInit.headers);
      headers.set(RENDER_ORG_ID_HEADER, renderOrgId);
      nextInit.headers = headers;
    }
  }

  const res = await fetch(input, nextInit);

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
