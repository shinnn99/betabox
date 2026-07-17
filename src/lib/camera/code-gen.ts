// Auto-generate `camera_code` from the operator-typed Vị trí (location),
// so the onboarder gõ Vị trí một lần ra cả Tên + Mã. Client-side only —
// server has a unique index `uniq_camera_code_per_org` on
// (organization_id, camera_code) as the final guard; a 23505 there
// surfaces as "Mã camera đã tồn tại trong tổ chức." for the user to fix.
//
// Scope of uniqueness: per-tenant. The `existing` list passed in is the
// current tenant's camera list already loaded in the dialog, so a
// client-side Set covers 99% of collisions without an extra query.

interface ExistingCamera {
  id: string;
  camera_code: string;
}

// Slugify Vietnamese for use inside `camera_code` (charset: [a-z0-9_-]).
//
// Order matters:
//   1. NFD splits accented letters into base + combining marks
//      ("ó" → "o" + U+0301), EXCEPT `đ`/`Đ` which are their own code
//      points (U+0111 / U+0110) and DO NOT decompose. So the combining-
//      strip step below preserves them intact.
//   2. Strip the combining marks.
//   3. Replace `đ` and `Đ` explicitly — kept as TWO separate replaces
//      on purpose. A single `/đ/gi` would only catch the lowercase
//      form because Unicode case-fold doesn't map U+0110 → U+0111 in
//      the RegExp engine reliably; the split form is boring and
//      correct for both cases.
//   4. Lowercase, then squash anything outside [a-z0-9] into `_`.
export function slugifyVietnamese(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Fallback when the slug ends up empty (location was blank, or only
// emoji / punctuation). Returns the next `cam_NN` after the highest
// existing numeric-suffix code. Note: this alone does NOT guarantee
// uniqueness — callers MUST run the result through `ensureUnique` too.
// A warehouse with codes like `cam_ban_1, cam_ban_2` has no numeric
// suffix at all, so this returns `cam_01`; if `cam_01` is already
// used elsewhere, `ensureUnique` will bump it.
export function nextSequentialCode(existing: ExistingCamera[]): string {
  let max = 0;
  for (const c of existing) {
    const m = c.camera_code.match(/^cam_(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `cam_${String(max + 1).padStart(2, "0")}`;
}

// Return `base` if unused, otherwise append `_2`, `_3`, ... until free.
// `excludeId` lets the caller exclude the camera currently being edited
// so a no-op re-save doesn't self-collide (the touched guard already
// prevents auto-fill from running in edit mode, but defense-in-depth).
export function ensureUnique(
  base: string,
  existing: ExistingCamera[],
  excludeId?: string,
): string {
  const codes = new Set<string>();
  for (const c of existing) {
    if (excludeId && c.id === excludeId) continue;
    codes.add(c.camera_code);
  }
  if (!codes.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`;
    if (!codes.has(candidate)) return candidate;
  }
  // Extremely unlikely (>99 collisions on same base). Fall back to a
  // millisecond suffix so the operator never sees "cannot generate".
  return `${base}_${Date.now().toString(36)}`;
}

// One-shot: slugify → cam_-prefix → fallback sequential if empty →
// ensure unique. This is the entry point the form calls.
export function generateCameraCode(
  location: string,
  existing: ExistingCamera[],
  excludeId?: string,
): string {
  const slug = slugifyVietnamese(location);
  const base = slug ? `cam_${slug}` : nextSequentialCode(existing);
  return ensureUnique(base, existing, excludeId);
}
