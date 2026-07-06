import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { uploadWithTimeout } from "../src/upload";

/**
 * Test CRIT-4: uploadWithTimeout.
 *
 * Scenario cover:
 *   - 200 OK trong 1 attempt.
 *   - Server treo (không response) → abort timeout, không kẹt.
 *   - HTTP 401 → non-retryable, dừng ngay attempt 1.
 *   - HTTP 500 → retryable, retry đủ maxAttempts rồi trả http_5xx.
 *   - External abort giữa upload → aborted.
 *   - Body size lớn hơn ngưỡng nhỏ → timeout tính đúng floor.
 */

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/put`,
        close: () =>
          new Promise<void>((res) => {
            srv.closeAllConnections?.();
            srv.close(() => res());
          }),
      });
    });
  });
}

test("uploadWithTimeout: 200 OK first attempt", async () => {
  const { url, close } = await startServer((req, res) => {
    let received = 0;
    req.on("data", (c) => (received += c.length));
    req.on("end", () => {
      res.writeHead(200);
      res.end(`ok:${received}`);
    });
  });
  try {
    const body = Buffer.alloc(1024, 0xab);
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 2000,
      maxAttempts: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
  } finally {
    await close();
  }
});

test("uploadWithTimeout: server hang → timeout, không kẹt", async () => {
  const { url, close } = await startServer((req) => {
    // Nuốt body, không response — mô phỏng POP treo.
    req.resume();
  });
  try {
    const body = Buffer.alloc(1024);
    const t0 = Date.now();
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 200,
      maxTimeoutMs: 200,
      baseTimeoutMs: 200,
      perMbMs: 0,
      maxAttempts: 2,
      initialBackoffMs: 10,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "timeout");
    // 2 attempt * 200ms + 1 backoff jitter ~10ms ≈ 400-600ms, không được >5s
    assert.ok(elapsed < 5000, `elapsed ${elapsed} phải dưới 5s (không kẹt)`);
  } finally {
    await close();
  }
});

test("uploadWithTimeout: HTTP 401 → non-retryable, attempt=1", async () => {
  let hits = 0;
  const { url, close } = await startServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(401);
      res.end("unauthorized");
    });
  });
  try {
    const body = Buffer.alloc(64);
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 500,
      maxAttempts: 5,
      initialBackoffMs: 10,
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "http_4xx");
    assert.equal(r.httpStatus, 401);
    assert.equal(r.attempts, 1);
    assert.equal(hits, 1, "server chỉ nhận 1 request");
  } finally {
    await close();
  }
});

test("uploadWithTimeout: HTTP 500 → retry hết attempt rồi trả http_5xx", async () => {
  let hits = 0;
  const { url, close } = await startServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(500);
      res.end("boom");
    });
  });
  try {
    const body = Buffer.alloc(64);
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 500,
      maxAttempts: 3,
      initialBackoffMs: 10,
      backoffFactor: 1.5,
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "http_5xx");
    assert.equal(r.httpStatus, 500);
    assert.equal(r.attempts, 3);
    assert.equal(hits, 3, "server nhận đủ 3 request");
  } finally {
    await close();
  }
});

test("uploadWithTimeout: external abort → dừng ngay, không retry tiếp", async () => {
  const { url, close } = await startServer((req) => {
    req.resume(); // treo
  });
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const body = Buffer.alloc(64);
    const t0 = Date.now();
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 5000,
      maxTimeoutMs: 5000,
      baseTimeoutMs: 5000,
      perMbMs: 0,
      maxAttempts: 3,
      initialBackoffMs: 10,
      externalSignal: ctrl.signal,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "aborted");
    assert.ok(elapsed < 500, `elapsed ${elapsed} phải dưới 500ms (abort dừng ngay)`);
  } finally {
    await close();
  }
});

test("uploadWithTimeout: timeout tính theo size — file 4MB @ 100ms/MB + base 100 → ~500ms", async () => {
  // Không có cách probe internal timeout từ ngoài. Test qua hành vi:
  // với body 4MB + perMbMs=100 + baseTimeoutMs=100 + min=50 max=1000,
  // timeout ≈ 500ms — server hang phải trả timeout trong khoảng 500-1500ms.
  const { url, close } = await startServer((req) => {
    req.resume();
  });
  try {
    const body = Buffer.alloc(4 * 1024 * 1024, 0xcd);
    const t0 = Date.now();
    const r = await uploadWithTimeout(url, body, {
      minTimeoutMs: 50,
      maxTimeoutMs: 1500,
      baseTimeoutMs: 100,
      perMbMs: 100,
      maxAttempts: 1,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "timeout");
    assert.ok(
      elapsed >= 400 && elapsed <= 1500,
      `elapsed ${elapsed}ms phải nằm ~500ms (base 100 + 4MB * 100ms/MB)`,
    );
  } finally {
    await close();
  }
});

test("uploadWithTimeout: KHÔNG log signed URL trong errorMessage", async () => {
  const { url, close } = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(403);
      res.end("forbidden");
    });
  });
  try {
    const body = Buffer.alloc(16);
    const secretUrlWithToken = `${url}?token=SECRET_TOKEN_XYZ`;
    const r = await uploadWithTimeout(secretUrlWithToken, body, {
      minTimeoutMs: 500,
      maxAttempts: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, "http_4xx");
    assert.doesNotMatch(
      r.errorMessage ?? "",
      /SECRET_TOKEN_XYZ/,
      "errorMessage không được chứa token URL",
    );
  } finally {
    await close();
  }
});
