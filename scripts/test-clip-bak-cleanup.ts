/* eslint-disable @typescript-eslint/no-explicit-any */
// Contract test for cleanupOrphanBakClips. Distinguishes two cases the
// brief calls out:
//   (A) .bak with a ready replacement clip whose file exists on disk
//       → expected to be DELETED after TTL.
//   (B) .bak with NO replacement row in DB
//       → expected to be PRESERVED with a warning.
//
// Run from repo root:
//   node --experimental-strip-types scripts/test-clip-bak-cleanup.ts
//
// Uses a temp dir + mock admin client; does NOT touch the production DB
// or production RECORDING_DIR. Exits 0 on success, 1 on failure.

import { mkdtemp, mkdir, writeFile, utimes, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cleanupOrphanBakClips } from "../src/lib/order-proof/clip-bak-cleanup.ts";

type Row = { packing_event_id: string; clip_path: string; status: string };

// Minimal stub of the Supabase admin client. Only the chained method
// chain used by clip-bak-cleanup.ts (.from().select().eq().eq().in())
// is mocked. Anything else throws so a future refactor that calls
// something unexpected fails the test loudly.
function mockAdmin(rows: Row[]): any {
  return {
    from(_table: string) {
      let _ready: Row[] = rows;
      const chain: any = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, val: string) {
          if (col === "status") _ready = _ready.filter((r) => r.status === val);
          return chain;
        },
        in(col: string, vals: string[]) {
          if (col === "packing_event_id") {
            const set = new Set(vals);
            _ready = _ready.filter((r) => set.has(r.packing_event_id));
          }
          return Promise.resolve({ data: _ready, error: null });
        },
      };
      return chain;
    },
  };
}

async function assertEq<T>(actual: T, expected: T, label: string): Promise<void> {
  if (actual !== expected) {
    console.error(
      `FAIL: ${label} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
    );
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "bak-cleanup-test-"));
  console.log(`temp root: ${root}`);

  const waybillA = "TEST_A_WAYBILL";
  const waybillB = "TEST_B_WAYBILL";
  const eventA = randomUUID();
  const eventB = randomUUID();

  const dirA = path.join(root, waybillA);
  const dirB = path.join(root, waybillB);
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  // Case A: .bak + a freshly written replacement clip
  const bakA = path.join(dirA, `${eventA}.mp4.bak`);
  const replacementA = path.join(dirA, `${eventA}.mp4`);
  await writeFile(bakA, "BAK_A");
  await writeFile(replacementA, "REPLACEMENT_A");

  // Case B: .bak ONLY, no replacement file or row
  const bakB = path.join(dirB, `${eventB}.mp4.bak`);
  await writeFile(bakB, "BAK_B");

  // Force both .bak mtimes well past the TTL.
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(bakA, longAgo, longAgo);
  await utimes(bakB, longAgo, longAgo);

  // DB stub: only case A has a ready row.
  const adminMock = mockAdmin([
    {
      packing_event_id: eventA,
      clip_path: replacementA,
      status: "ready",
    },
  ]);

  const report = await cleanupOrphanBakClips({
    organizationId: "11111111-1111-1111-1111-111111111111",
    rootOverride: root,
    adminOverride: adminMock,
  });

  console.log("report:", JSON.stringify(report, null, 2));

  await assertEq(report.scanned, 2, "scanned == 2");
  await assertEq(report.deleted, 1, "deleted == 1 (only A)");
  await assertEq(
    report.preserved_no_replacement,
    1,
    "preserved_no_replacement == 1 (B)",
  );

  // Filesystem assertions: A's .bak gone, B's .bak still there,
  // replacement file untouched.
  await assertEq(existsSync(bakA), false, "bakA deleted from disk");
  await assertEq(existsSync(bakB), true, "bakB preserved on disk");
  await assertEq(existsSync(replacementA), true, "replacement A untouched");

  // ---- Case C: .bak with replacement ROW but replacement FILE missing.
  // Must be preserved (don't leave operator with neither file).
  const waybillC = "TEST_C_WAYBILL";
  const eventC = randomUUID();
  const dirC = path.join(root, waybillC);
  await mkdir(dirC, { recursive: true });
  const bakC = path.join(dirC, `${eventC}.mp4.bak`);
  await writeFile(bakC, "BAK_C");
  await utimes(bakC, longAgo, longAgo);
  // Replacement row points to a path that doesn't exist on disk.
  const adminMock2 = mockAdmin([
    {
      packing_event_id: eventC,
      clip_path: path.join(dirC, `${eventC}.mp4`), // intentionally not created
      status: "ready",
    },
  ]);

  const report2 = await cleanupOrphanBakClips({
    organizationId: "11111111-1111-1111-1111-111111111111",
    rootOverride: root,
    adminOverride: adminMock2,
  });
  // After case A we deleted bakA, so only bakB and bakC remain. Reports
  // count files seen this call only.
  console.log("report2:", JSON.stringify(report2, null, 2));
  await assertEq(
    report2.preserved_replacement_file_missing,
    1,
    "case C: preserved_replacement_file_missing == 1",
  );
  await assertEq(existsSync(bakC), true, "bakC preserved on disk");

  // ---- Case D: recent .bak (within TTL) must be preserved even if there
  // is a valid replacement.
  const waybillD = "TEST_D_WAYBILL";
  const eventD = randomUUID();
  const dirD = path.join(root, waybillD);
  await mkdir(dirD, { recursive: true });
  const bakD = path.join(dirD, `${eventD}.mp4.bak`);
  const replacementD = path.join(dirD, `${eventD}.mp4`);
  await writeFile(bakD, "BAK_D");
  await writeFile(replacementD, "REPLACEMENT_D");
  // Default mtime = now → within TTL.
  const adminMock3 = mockAdmin([
    {
      packing_event_id: eventD,
      clip_path: replacementD,
      status: "ready",
    },
  ]);
  const report3 = await cleanupOrphanBakClips({
    organizationId: "11111111-1111-1111-1111-111111111111",
    rootOverride: root,
    adminOverride: adminMock3,
  });
  console.log("report3:", JSON.stringify(report3, null, 2));
  await assertEq(
    report3.preserved_too_recent,
    1,
    "case D: preserved_too_recent == 1",
  );
  await assertEq(existsSync(bakD), true, "bakD preserved on disk (too recent)");

  // Touch verification: stat the surviving files to make sure they
  // weren't truncated.
  const stB = await stat(bakB);
  await assertEq(stB.size > 0, true, "bakB size > 0");

  // Cleanup
  const remaining = await readdir(root, { recursive: true });
  console.log(`remaining files in temp root: ${remaining.length}`);

  console.log("\nALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
