// Minimal Node ESM resolver hook so `import "@/lib/..."` works when
// running TS test scripts via `--experimental-strip-types`. Strips the
// repo's tsconfig path alias `@/* -> ./src/*` only — anything else is
// delegated to the default resolver.
//
// Used by scripts/test-clip-bak-cleanup.ts. Not loaded in app runtime;
// Next.js' bundler does the same job there.

import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

// repo root = parent of /scripts
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function tryExts(absNoExt) {
  // Mirror Next/TS resolution priority. We only need .ts here since the
  // app code is all .ts and tests are run with --experimental-strip-types.
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = absNoExt + ext;
    if (existsSync(candidate)) return candidate;
  }
  // index files
  for (const ext of [".ts", ".tsx", ".js"]) {
    const candidate = path.join(absNoExt, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // Test-only override: swap the supabase admin module for a counting
  // stub when BC_TEST_STUB_ADMIN=1. Tests set this env before importing
  // service modules so all cache reads go to the stub, not Supabase.
  const adminAliases = new Set([
    "@/lib/supabase/admin",
    "../supabase/admin",
    "./supabase/admin",
  ]);
  if (
    process.env.BC_TEST_STUB_ADMIN === "1" &&
    adminAliases.has(specifier)
  ) {
    const stub = path.join(REPO_ROOT, "scripts", "admin-stub.ts");
    return {
      url: pathToFileURL(stub).href,
      shortCircuit: true,
      format: "module",
    };
  }

  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2); // strip "@/"
    const abs = path.join(SRC_ROOT, rel);
    const resolved = tryExts(abs) ?? abs;
    return {
      url: pathToFileURL(resolved).href,
      shortCircuit: true,
      format: resolved.endsWith(".ts") || resolved.endsWith(".tsx")
        ? "module"
        : undefined,
    };
  }
  // server-only throws at import time outside the Next runtime. Replace
  // it with a no-op so we can import server modules into a Node test.
  // This stub MUST NOT be reachable from app code — only from /scripts.
  if (specifier === "server-only") {
    const stub = path.join(REPO_ROOT, "scripts", "server-only-stub.mjs");
    return {
      url: pathToFileURL(stub).href,
      shortCircuit: true,
      format: "module",
    };
  }
  // Relative imports without an extension. The app's tsconfig sets
  // `moduleResolution: bundler` so Next resolves them at build time; in
  // raw Node ESM we have to add the extension ourselves.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !specifier.includes("?") &&
    !/\.(m?[jt]sx?|json|node)$/.test(specifier)
  ) {
    const parentUrl = context.parentURL;
    if (parentUrl?.startsWith("file:")) {
      const parentPath = fileURLToPath(parentUrl);
      const abs = path.resolve(path.dirname(parentPath), specifier);
      const resolved = tryExts(abs);
      if (resolved) {
        return {
          url: pathToFileURL(resolved).href,
          shortCircuit: true,
          format: resolved.endsWith(".ts") || resolved.endsWith(".tsx")
            ? "module"
            : undefined,
        };
      }
    }
  }
  return nextResolve(specifier, context);
}

// Strip TS types for any .ts/.tsx file we resolved above. Node's built-in
// --experimental-strip-types only kicks in for entry points; when a
// loader's resolve hook returns `format: 'module'` for a .ts file, the
// default load hook tries to parse it as JS and fails. We do the strip
// ourselves via the node:module helper.
export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const src = readFileSync(filePath, "utf8");
    const stripped = stripTypeScriptTypes(src, { mode: "strip" });
    return {
      format: "module",
      source: stripped,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
