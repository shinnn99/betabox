import "server-only";

// In-process lock map for generate/regenerate. Extracted out of
// service.ts so the .bak cleanup module can read it without forming a
// circular import with service.ts (which imports the cleanup module to
// run the opportunistic sweep on regen success).
//
// Cross-process safety is NOT provided by this map — see the long
// comment at the original declaration site for the trade-off rationale.
// Acceptable risk: a duplicate generate at most leaves an orphan output
// file; the cleanup sweep gated on a ready replacement removes the
// orphan once one exists.

// Generic Promise — the value type only matters to service.ts, which
// wraps these helpers in typed shims. Keeping the value as `unknown`
// here avoids re-exporting GenerateOutcome and re-introducing a cycle.
const inFlight = new Map<string, Promise<unknown>>();

export function inFlightGet(key: string): Promise<unknown> | undefined {
  return inFlight.get(key);
}

export function inFlightSet(key: string, p: Promise<unknown>): void {
  inFlight.set(key, p);
}

export function inFlightDelete(key: string): void {
  inFlight.delete(key);
}

export function isGenerateInFlightForEvent(
  organizationId: string,
  packingEventId: string,
): boolean {
  return inFlight.has(`${organizationId}:${packingEventId}`);
}
