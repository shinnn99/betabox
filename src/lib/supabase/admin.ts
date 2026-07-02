import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypass RLS. Chỉ dùng trong Route Handlers / Server Actions
 * sau khi đã verify quyền của caller.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local before using admin client."
    );
  }

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
