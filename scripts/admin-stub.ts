// Test-only stub for @/lib/supabase/admin. Replaces createAdminClient
// with a counting mock so cache tests can assert read-count without
// hitting Supabase. Loaded via node-path-alias-loader.mjs URL rewrite
// when SCRIPT_TEST_MODE=cache is set.
/* eslint-disable @typescript-eslint/no-explicit-any */

// Module-level counters the test reads back via globalThis.
const g = globalThis as any;
g.__bc_camera_select_calls__ = 0;
g.__bc_station_device_select_calls__ = 0;

function fakeAdmin(): any {
  return {
    from(table: string) {
      if (table === "cameras") g.__bc_camera_select_calls__ += 1;
      if (table === "station_devices") g.__bc_station_device_select_calls__ += 1;
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        neq() { return chain; },
        in() { return Promise.resolve({ data: [], error: null }); },
        is() { return chain; },
        order() { return Promise.resolve({ data: [], error: null }); },
        single() { return Promise.resolve({ data: null, error: null }); },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return chain; },
        update() { return chain; },
        delete() { return Promise.resolve({ data: null, error: null, count: 0 }); },
      };
      return chain;
    },
  };
}

export function createAdminClient(): any {
  return fakeAdmin();
}
