/**
 * Normalize a raw scanned string into a usable waybill code.
 *
 * Trims, strips control characters, uppercases. Does NOT try to fix
 * suspected encoding garbage — that's a hardware/keyboard-layout issue and
 * silently rewriting it would hide a real config problem from the operator.
 * Instead we surface a `warning` so the UI/agent can show "scanner đang
 * sai layout/encoding".
 *
 * Used both server-side (raw scan ingestion) and on the HID fallback page.
 */
export interface NormalizeResult {
  /** Normalized code suitable for storage/lookup. Empty if input was empty. */
  normalized: string;
  /**
   * Set when the raw input contained characters that strongly suggest a
   * misconfigured scanner / wrong keyboard layout — e.g. typographic
   * symbols (º § ∞ ¶ ¡ • ™) instead of digits/letters.
   *
   * Never blocks ingestion; raw_value is always preserved for debugging.
   */
  warning: "suspicious_encoding" | null;
}

const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

// Symbols that don't belong in a waybill code and usually indicate a
// keyboard-layout / scanner-configuration mismatch (Vietnamese AZERTY,
// Mac dead keys, scanner emitting Alt+NumPad sequences, etc.).
const SUSPICIOUS_SYMBOLS_RE = /[º§∞¶¡¢£¤¥¦¨©ª«¬®¯°±²³´µ·¸¹»¼½¾¿×÷•™€]/;

export function normalizeWaybillCode(raw: string): NormalizeResult {
  if (typeof raw !== "string") return { normalized: "", warning: null };

  const stripped = raw.replace(CONTROL_CHARS_RE, "").trim();
  const normalized = stripped.toUpperCase();

  const warning = SUSPICIOUS_SYMBOLS_RE.test(raw) ? "suspicious_encoding" : null;

  return { normalized, warning };
}
