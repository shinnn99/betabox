// Next.js calls register() once per server instance, before any
// requests are handled. We use it to reconcile camera recording state:
// any session left in `recording` belongs to a dead Node process and
// must be marked `error`. See AGENTS.md note about Next 16 behaviour.

export async function register() {
  // Only run on the Node.js runtime. Edge instances also call register
  // but cannot use fs / Supabase admin client.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic import keeps the boot-time module graph minimal.
  const { sweepStaleSessions } = await import(
    "@/lib/camera/recording-service"
  );
  try {
    await sweepStaleSessions();
  } catch (err) {
    console.error("[instrumentation] sweepStaleSessions failed", err);
  }
}
