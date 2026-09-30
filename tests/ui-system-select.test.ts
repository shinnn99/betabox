import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx|jsx)$/.test(entry.name) ? [path] : [];
  });
}

test("toàn bộ giao diện dùng Select của hệ thống, không dùng dropdown mặc định", () => {
  const offenders = sourceFiles("src")
    .filter((path) => /<select\b/.test(readFileSync(path, "utf8")))
    .map((path) => path.replaceAll("\\", "/"));

  assert.deepEqual(offenders, []);
});


test("toàn bộ giao diện dùng bộ chọn ngày của hệ thống, không dùng lịch mặc định", () => {
  const nativeDateControl = /<input\b[^>]*\btype\s*=\s*["'](?:date|datetime-local|month|week|time)["']/i;
  const offenders = sourceFiles("src")
    .filter((path) => nativeDateControl.test(readFileSync(path, "utf8")))
    .map((path) => path.replaceAll("\\", "/"));

  assert.deepEqual(offenders, []);
});

// Marker kept in English so code search can find this regression guard.
// native date/time controls
