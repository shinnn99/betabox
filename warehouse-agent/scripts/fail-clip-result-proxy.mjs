/**
 * Harness tái hiện sự cố 11/08: proxy pass-through tới backend thật,
 * NHƯNG trả 451 cho đúng một endpoint `/api/agent/clip-cut-result`.
 *
 * Vì sao không đơn giản trỏ BACKEND_URL sang host chết: agent sẽ không
 * poll được lệnh, nên không có lệnh cắt nào để mà fail callback — ca
 * kiểm sẽ xanh vì không kích, đúng loại "xanh giả" cần tránh. Sự cố
 * thật cũng có hình dạng này: poll-commands và command-result đi VPS
 * bình thường, riêng clip-upload-url/clip-cut-result trúng Vercel cũ.
 *
 * HMAC v2 ký `method + canonicalPath + body`, KHÔNG ký host — nên
 * forward nguyên headers + body byte-exact là chữ ký vẫn hợp lệ.
 *
 * Dùng:
 *   node scripts/fail-clip-result-proxy.mjs            # 451 cho clip-cut-result
 *   PASSTHROUGH=1 node scripts/fail-clip-result-proxy.mjs   # pass hết (ca drain)
 *
 * Rồi đặt trong .env của agent:  BACKEND_URL=http://127.0.0.1:8099
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8099);
const UPSTREAM = process.env.UPSTREAM ?? "https://betabox.betacom.agency";
const PASSTHROUGH = process.env.PASSTHROUGH === "1";
const FAIL_PATH = "/api/agent/clip-cut-result";

// Nguyên văn thân + header mà Vercel trả khi deployment bị khoá — để
// agent nhìn thấy đúng thứ nó đã nhìn thấy hôm 11/08.
const VERCEL_451_BODY =
  "This content has been blocked for legal reasons\n\nDEPLOYMENT_DISABLED\n\nhkg1::harness-fake\n";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const path = req.url ?? "/";

  if (!PASSTHROUGH && path === FAIL_PATH) {
    console.log(`[proxy] ${req.method} ${path} → 451 (giả lập Vercel cũ)`);
    res.writeHead(451, {
      "content-type": "text/plain; charset=utf-8",
      "x-vercel-error": "DEPLOYMENT_DISABLED",
    });
    res.end(VERCEL_451_BODY);
    return;
  }

  // Forward: giữ nguyên header agent (x-agent-code/signature/nonce/ts),
  // bỏ host để undici tự đặt đúng host upstream.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];

  try {
    const upstream = await fetch(`${UPSTREAM}${path}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
      redirect: "manual",
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    console.log(`[proxy] ${req.method} ${path} → ${upstream.status} (${buf.length}B)`);
    const out = {};
    upstream.headers.forEach((v, k) => {
      // content-encoding/length đã được undici giải nén — giữ lại sẽ lệch.
      if (k === "content-encoding" || k === "content-length") return;
      out[k] = v;
    });
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch (err) {
    console.error(`[proxy] ${req.method} ${path} → LỖI ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_upstream_failed" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[proxy] nghe 127.0.0.1:${PORT} → ${UPSTREAM} | chế độ: ${
      PASSTHROUGH ? "PASS HẾT (ca drain)" : `451 cho ${FAIL_PATH} (ca ghi)`
    }`,
  );
});
