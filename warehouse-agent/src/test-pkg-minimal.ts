/**
 * Test tối thiểu cho @yao-pkg/pkg + serialport native binding.
 *
 * Mục đích: verify pkg bundle được serialport `.node` binary. Đây là
 * chỗ RỦI RO CAO NHẤT của toàn Việc 3 — nếu vỡ ở đây, cả hướng đóng
 * gói bằng pkg phải xét lại (không phải test happy path).
 *
 * Chạy exe này:
 *   - PASS: log "SERIALPORT OK — found N ports" + exit 0.
 *   - FAIL: crash với "Error: Cannot find module ... .node" hoặc
 *     "The specified module could not be found" → serialport binding
 *     KHÔNG bundle được vào exe.
 *
 * Nếu FAIL: KHÔNG tự đổi tool. Dán output cho anh, bàn phương án
 * (tách serialport ra process riêng, hoặc đóng gói kiểu khác).
 */
import { SerialPort } from "serialport";

async function main(): Promise<void> {
  console.log("=== BETACOM AGENT — pkg serialport test ===");
  console.log(`Node runtime: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Executable: ${process.execPath}`);
  console.log(`Is packaged: ${"pkg" in process ? "YES" : "NO"}`);
  console.log("");

  try {
    console.log("Listing serial ports...");
    const ports = await SerialPort.list();
    console.log(`SERIALPORT OK — found ${ports.length} port(s)`);
    for (const p of ports) {
      console.log(
        `  - ${p.path} | ${p.manufacturer ?? "(unknown mfr)"} | ` +
          `VID:${p.vendorId ?? "-"} PID:${p.productId ?? "-"}`,
      );
    }
    console.log("");
    console.log("=== TEST PASS ===");
    process.exit(0);
  } catch (err) {
    console.error("SERIALPORT FAILED:", err);
    console.log("=== TEST FAIL ===");
    process.exit(1);
  }
}

void main();
