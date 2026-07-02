// No-op replacement for the `server-only` package used by the Node test
// runner. The real package throws at import time so that bundlers can
// hard-fail client builds that drag in server modules — that's a
// runtime guarantee for Next.js, not for plain `node`. Only loaded
// when scripts/node-path-alias-loader.mjs is active.
export {};
